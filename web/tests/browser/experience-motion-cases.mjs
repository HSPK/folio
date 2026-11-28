import { test, expect, fs, path, root, buildRoot, chooseView, openSettingsDialog, confirmDialog, userDocumentUrl, openFixture } from "./fixture.mjs";
import { collaborativeLibrary } from "./collaboration-cases.mjs";

test("native menus reverse an unfinished close without flashing or accepting hidden actions", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const trigger = page.locator("#more-menu > button");
  const panel = page.locator("#more-actions-panel");
  await trigger.click();
  await expect(panel).toHaveCSS("opacity", "1");
  const reversal = await panel.evaluate(async panel => {
    const trigger = document.querySelector("#more-menu > button");
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    trigger.click();
    const inertWhileClosing = panel.inert;
    await frame();
    await frame();
    const closing = Number(getComputedStyle(panel).opacity);
    trigger.click();
    await frame();
    return {
      inertWhileClosing, closing, reopened: Number(getComputedStyle(panel).opacity),
      open: panel.matches(":popover-open"), inertAfterReopen: panel.inert,
    };
  });
  expect(reversal.inertWhileClosing).toBe(true);
  expect(reversal.open).toBe(true);
  expect(reversal.inertAfterReopen).toBe(false);
  expect(reversal.reopened).toBeGreaterThanOrEqual(reversal.closing - .08);
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(trigger).toBeFocused();
});

for (const reducedBy of ["system", "preference"]) {
  test(`loading stays visible without movement when motion is reduced by ${reducedBy}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: reducedBy === "system" ? "reduce" : "no-preference" });
    if (reducedBy === "preference") {
      await openSettingsDialog(page, { section: "accessibility" });
      await page.locator("#settings-reduced-motion").check();
      await page.locator("#settings-save").click();
      await expect(page.locator("#settings-dialog")).toBeHidden();
    }
    const editor = page.locator(".rich-editor");
    await editor.evaluate(node => node.setAttribute("aria-busy", "true"));
    const loading = await editor.evaluate(node => {
      const style = getComputedStyle(node, "::before");
      return { opacity: Number(style.opacity), animation: style.animationName, width: parseFloat(style.width) };
    });
    expect(loading.opacity).toBeGreaterThan(.1);
    expect(loading.animation).toBe("none");
    expect(loading.width).toBeGreaterThan(0);
    await editor.evaluate(node => node.removeAttribute("aria-busy"));
  });
}

for (const width of [1440, 390]) {
  test(`closing a changed project form is reversible and consistent at ${width}px`, async ({ browser }) => {
    const library = await collaborativeLibrary(browser, { participants: 1, sharing: "private" });
    try {
      const [page] = library.pages;
      await page.setViewportSize({ width, height: 960 });
      if (await page.locator("body").getAttribute("data-sidebar") === "closed")
        await page.locator("#sidebar-toggle").click();
      await page.locator("#projects-open").click();
      for (const view of ["create", "sharing"]) {
        if (view === "create") await page.locator("#project-new").click();
        else await page.locator(".project-manage").first().click();
        const name = page.locator(view === "create" ? "#project-name" : "#sharing-name");
        await name.fill("Keep this unfinished change");
        await page.locator("#projects-close").click();
        await expect(page.locator("#project-confirm")).toBeVisible();
        await expect(name).toHaveValue("Keep this unfinished change");
        await confirmDialog(page, { accept: false });
        await expect(name).toHaveValue("Keep this unfinished change");
        await page.locator("#projects-close").click();
        await confirmDialog(page);
        await expect(page.locator("#projects-dialog")).toBeHidden();
        await page.locator("#projects-open").click();
        await expect(page.locator("#projects-browser")).toBeVisible();
      }
    } finally { await library.close(); }
  });
}

test("downloading another note leaves the current writing session, text and route alone", async ({ page }) => {
  await chooseView(page, "editor");
  const writing = "# My current work\n\nKeep this text and my place.\n";
  await page.locator("#editor").fill(writing);
  const url = page.url();
  await page.locator('button[data-path="Second.md"]').click({ button: "right" });
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("menuitem", { name: "Download", exact: true }).click(),
  ]);
  expect(await fs.readFile(await download.path(), "utf8")).toBe(await fs.readFile(path.join(root, "Second.md"), "utf8"));
  await expect(page.locator("#editor")).toHaveValue(writing);
  await expect(page.locator("#document-title")).toHaveText("README");
  expect(page.url()).toBe(url);
});

test("downloading the open note includes its unsaved text", async ({ page }) => {
  await chooseView(page, "editor");
  const writing = "# The current unsaved draft\n";
  await page.locator("#editor").fill(writing);
  await page.locator('button[data-path="README.md"]').click({ button: "right" });
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("menuitem", { name: "Download", exact: true }).click(),
  ]);
  expect(await fs.readFile(await download.path(), "utf8")).toBe(writing);
  await expect(page.locator("#editor")).toHaveValue(writing);
});

test("image quality appears only when it can affect the chosen image format", async ({ page }) => {
  await openSettingsDialog(page, { section: "library" });
  const compression = page.locator("#settings-image-compression");
  const quality = page.locator(".setting-card:has(#settings-image-quality)");
  await expect(quality).toBeHidden();
  await page.locator("#settings-search").fill("JPEG quality");
  await expect(quality).toBeVisible();
  await page.locator("#settings-search").fill("");
  await expect(quality).toBeHidden();
  await compression.selectOption("jpeg");
  await expect(quality).toBeVisible();
  await page.locator("#settings-image-quality").focus();
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await compression.selectOption("webp");
  await expect(quality).toBeHidden();
  await compression.selectOption("jpeg");
  await expect(page.locator("#settings-image-quality")).toHaveValue("90");
  await page.locator("#settings-cancel").click();
});

test("a tag save rejected after dismissal reports the failure without touching the newer dialog", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { participants: 1, sharing: "private", source: true });
  let release = () => {};
  try {
    const [page] = library.pages;
    let began;
    const started = new Promise(resolve => { began = resolve; });
    const pending = new Promise(resolve => { release = resolve; });
    await page.route("**/api/document", async route => {
      if (route.request().method() !== "PUT") return route.continue();
      began();
      await pending;
      await route.fulfill({ status: 422, json: { error: "Tag storage rejected this change." } });
    }, { times: 1 });
    await page.locator('button[data-path="Other.md"]').click({ button: "right" });
    await page.getByRole("menuitem", { name: "Edit tags", exact: true }).click();
    await page.locator("#tags-input").fill("submitted tags");
    await page.getByRole("button", { name: "Save tags", exact: true }).click();
    await started;
    await page.keyboard.press("Escape");
    await expect(page.locator("#tags-dialog")).toBeHidden();
    await page.locator("#more-menu > button").click();
    await page.locator("#document-tags-open").click();
    await page.locator("#tags-input").fill("Newer dialog input");
    release();
    await expect(page.locator("#document-message")).toContainText("Tags not saved for Other.md:");
    await expect(page.locator("#document-message")).toContainText("Tag storage rejected this change.");
    await expect(page.locator("#tags-input")).toHaveValue("Newer dialog input");
    await expect(page.locator("#tags-error")).toBeHidden();
    await page.locator("#tags-cancel").click();
  } finally { release(); await library.close(); }
});

test("properties save failure after dismissal is visible without replacing a newer properties form", async ({ page }) => {
  const paths = ["Experience-pending.js", "Experience-newer.js"];
  let release = () => {};
  try {
    for (const name of paths) await fs.writeFile(path.join(root, name), "const example = true;\n");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const open = async name => {
      await page.locator(`[data-entry-path="${name}"]`).click({ button: "right" });
      await page.getByRole("menuitem", { name: "Properties", exact: true }).click();
      await expect(page.locator("#file-property-title")).toBeVisible();
    };
    let began;
    const started = new Promise(resolve => { began = resolve; });
    const pending = new Promise(resolve => { release = resolve; });
    await page.route("**/api/file-properties", async route => {
      if (route.request().method() !== "PUT") return route.continue();
      began();
      await pending;
      await route.fulfill({ status: 422, json: { error: "Property storage rejected this change." } });
    }, { times: 1 });
    await open(paths[0]);
    await page.locator("#file-property-title").fill("Submitted title");
    await page.locator("#file-properties-save").click();
    await started;
    await page.locator("#close-details").click();
    await expect(page.locator("#details-dialog")).toBeHidden();
    await open(paths[1]);
    await page.locator("#file-property-title").fill("Newer properties input");
    release();
    await expect(page.locator("#document-message")).toContainText(`Properties not saved for ${paths[0]}:`);
    await expect(page.locator("#file-property-title")).toHaveValue("Newer properties input");
    await expect(page.locator("#file-properties-error")).toBeHidden();
  } finally {
    release();
    for (const name of paths) await fs.rm(path.join(root, name), { force: true });
  }
});

test("saving settings responds immediately without interrupting newer edits", async ({ page }) => {
  let release;
  let began;
  const pending = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { began = resolve; });
  await page.route("**/api/preferences", async route => {
    if (route.request().method() !== "PUT") return route.continue();
    began();
    await pending;
    await route.continue();
  }, { times: 1 });
  try {
    await openSettingsDialog(page, { section: "appearance" });
    await page.locator("#settings-theme").selectOption("dark");
    await page.locator("#settings-save").click();
    await started;
    await expect(page.locator("#settings-form")).toHaveAttribute("aria-busy", "true");
    await expect(page.locator("#settings-save")).toHaveText("Saving…");
    await page.locator("#settings-theme").selectOption("light");
    release();
    await expect(page.locator("#settings-form")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#settings-save")).toHaveText("Save");
    await expect(page.locator("#settings-dialog")).toBeVisible();
    await expect(page.locator("#settings-theme")).toHaveValue("light");
    await expect(page.locator("#settings-form #settings-error")).toHaveText("Saved; newer edits unsaved");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.locator("#settings-save").click();
    await expect(page.locator("#settings-dialog")).toBeHidden();
  } finally { release(); }
});

test("accidental settings dismissal protects changes, including after a failed save", async ({ page }) => {
  await openSettingsDialog(page, { section: "appearance" });
  const original = await page.locator("#settings-theme").inputValue();
  const edited = original === "dark" ? "light" : "dark";
  await page.locator("#settings-theme").selectOption(edited);
  await page.locator("#settings-close").click();
  await expect(page.locator("#settings-dialog [data-confirmation-region]")).toBeVisible();
  await confirmDialog(page, { accept: false });
  await expect(page.locator("#settings-theme")).toHaveValue(edited);
  await page.route("**/api/preferences", route => route.request().method() === "PUT"
    ? route.fulfill({ status: 422, json: { error: "Try again without losing these settings." } }) : route.continue());
  await page.locator("#settings-save").click();
  await expect(page.locator("#settings-form #settings-error")).toHaveText("Try again without losing these settings.");
  await page.keyboard.press("Escape");
  await expect(page.locator("#settings-dialog [data-confirmation-region]")).toBeVisible();
  await confirmDialog(page);
  await expect(page.locator("#settings-dialog")).toBeHidden();
  await openSettingsDialog(page, { section: "appearance" });
  await expect(page.locator("#settings-theme")).toHaveValue(original);
  await page.locator("#settings-theme").selectOption(edited);
  await page.locator("#settings-cancel").click();
  await expect(page.locator("#settings-dialog")).toBeHidden();
});

test("properties retain newer edits, advance their revision and protect accidental dismissal", async ({ page }) => {
  const file = path.join(root, "Experience-properties.js");
  let release = () => {};
  await fs.writeFile(file, "const preserved = true;\n");
  try {
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const row = page.locator('[data-entry-path="Experience-properties.js"]');
    const open = async () => {
      await row.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Properties", exact: true }).click();
      await expect(page.locator("#details-dialog")).toBeVisible();
    };
    await open();
    await page.locator("#file-property-title").fill("A useful title");
    await page.locator("#close-details").click();
    await expect(page.locator("#details-dialog [data-confirmation-region]")).toBeVisible();
    await confirmDialog(page, { accept: false });
    const pending = new Promise(resolve => { release = resolve; });
    let began;
    const started = new Promise(resolve => { began = resolve; });
    await page.route("**/api/file-properties", async route => {
      if (route.request().method() !== "PUT") return route.continue();
      began();
      await pending;
      await route.continue();
    }, { times: 1 });
    await page.locator("#file-properties-save").click();
    await started;
    await expect(page.locator("#file-properties-save")).toHaveText("Saving…");
    await expect(page.locator("#file-properties-form")).toHaveAttribute("aria-busy", "true");
    await page.locator("#file-property-description").fill("Written while the first save was in flight");
    release();
    await expect(page.locator("#file-properties-error")).toHaveText("Saved; newer edits unsaved");
    await expect(page.locator("#details-dialog")).toBeVisible();
    await page.locator("#file-properties-save").click();
    await expect(page.locator("#details-dialog")).toBeHidden();
    await open();
    await expect(page.locator("#file-property-title")).toHaveValue("A useful title");
    await expect(page.locator("#file-property-description")).toHaveValue("Written while the first save was in flight");
    await page.locator("#close-details").click();
    await expect(page.locator("#details-dialog")).toBeHidden();
  } finally { release(); await fs.rm(file, { force: true }); }
});

test("another note's copy, favorite, share, tags, backlinks and restore never take over the current draft", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { participants: 1, sharing: "private", source: true, saveDelay: 5000 });
  try {
    const [page] = library.pages;
    const context = page.context();
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const otherUrl = new URL(await userDocumentUrl(context, library.url, "Other.md"));
    const id = otherUrl.searchParams.get("document");
    expect(id).toBeTruthy();
    const endpoint = new URL(`/api/document?id=${encodeURIComponent(id)}&render=source`, library.url).href;
    const options = { headers: { "X-Folio-Project": "default" } };
    const original = await (await context.request.get(endpoint, options)).json();
    const content = "# Other\n\nA revision worth keeping.\n";
    const saved = await context.request.put(new URL("/api/document", library.url).href, {
      ...options, data: { id, version: original.version, content },
    });
    expect(saved.ok(), await saved.text()).toBe(true);
    const draft = "# Still writing here\n\nDo not move my cursor or switch my note.\n";
    await page.locator("#editor").fill(draft);
    const url = page.url();
    const current = async () => {
      await expect(page.locator("#editor")).toHaveValue(draft);
      await expect(page.locator("#document-title")).toHaveText("Shared");
      expect(page.url()).toBe(url);
    };
    const action = async name => {
      await page.locator('button[data-path="Other.md"]').click({ button: "right" });
      await page.getByRole("menuitem", { name, exact: true }).click();
    };
    await action("Copy Markdown");
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(content);
    await current();
    await action("Favorite");
    await expect(page.locator("#document-message")).toHaveText("Added to favorites");
    await current();
    await expect(page.locator("#document-message")).toBeHidden();
    await action("Share file");
    await expect(page.locator("#sharing-title")).toHaveText("Document permissions");
    await current();
    await page.locator("#projects-close").click();
    await expect(page.locator("#projects-dialog")).toBeHidden();
    await action("Edit tags");
    await expect(page.locator("#tags-input")).toBeEnabled();
    await page.locator("#tags-input").fill("context-tag");
    await page.getByRole("button", { name: "Save tags", exact: true }).click();
    await expect(page.locator("#tags-dialog")).toBeHidden();
    expect(await fs.readFile(path.join(library.notes, "Other.md"), "utf8")).toContain("context-tag");
    await current();
    await action("Backlinks");
    await expect(page.locator("#backlinks-title")).toHaveText("Links to Other");
    await page.locator("#backlinks-close").click();
    await current();
    await action("History");
    await expect(page.locator("#history-list button")).not.toHaveCount(0);
    await page.locator("#history-list button").last().click();
    await expect(page.locator("#history-restore")).toBeEnabled();
    await page.locator("#history-restore").click();
    await confirmDialog(page);
    await expect(page.locator("#history-dialog")).toBeHidden();
    expect(await fs.readFile(path.join(library.notes, "Other.md"), "utf8")).toBe("# Other\n");
    await current();
  } finally { await library.close(); }
});

for (const platform of ["MacIntel", "Linux x86_64"]) {
  test(`shortcut hints follow the ${platform} platform and the configured command binding`, async ({ page }) => {
    await page.addInitScript(platform => Object.defineProperty(navigator, "platform", { value: platform }), platform);
    await page.reload();
    await openSettingsDialog(page, { section: "shortcuts" });
    const modifier = platform === "MacIntel" ? "⌘" : "Ctrl";
    await page.locator("#settings-command-shortcut").selectOption("primary-shift-p");
    await expect(page.locator("#command-palette-open kbd")).toHaveText(`${modifier}+Shift+P`);
    await expect(page.locator("#command-palette-open")).toHaveAttribute("title", `Commands (${modifier}+Shift+P)`);
    await expect(page.locator("#sidebar-hide")).toHaveAttribute("title", `Close sidebar (${modifier}+Shift+L)`);
    await page.locator("#settings-cancel").click();
    await expect(page.locator("#command-palette-open kbd")).toHaveText(`${modifier}+K`);
  });
}

for (const width of [390, 651, 1440]) {
  test(`real menus, settings, and link feedback remain usable in light and dark at ${width}px`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width === 390 });
    try {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      const page = await context.newPage();
      await openFixture(page, `Experience-links-${width}.md`, "# Links\n\n[Second note](Second.md)\n");
      if (width <= 650 && await page.locator("body").getAttribute("data-sidebar") === "open")
        await page.locator("#sidebar-hide").click();
      for (const colorScheme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme, reducedMotion: "no-preference" });
        const link = page.locator(".ProseMirror a").first();
        if (width === 390) await link.tap(); else await link.click();
        const tools = page.getByRole("toolbar", { name: "Link actions" });
        await expect(tools).toHaveCSS("opacity", "1");
        await tools.getByRole("button", { name: "Copy link", exact: true }).click();
        await expect(tools.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
        await expect(tools.getByRole("button", { name: "Copy link", exact: true })).toBeVisible();
        await page.locator("#more-menu > button").click();
        const menu = page.locator("#more-actions-panel");
        await expect(menu).toHaveCSS("opacity", "1");
        const bounds = await menu.boundingBox();
        expect(bounds.x).toBeGreaterThanOrEqual(7);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - 7);
        await page.screenshot({ path: path.join(buildRoot, `experience-${width}-${colorScheme}-menu.png`) });
        await page.locator("#settings-open").click();
        await expect(page.locator("#settings-dialog")).toHaveCSS("opacity", "1");
        if ((await page.locator("#settings-dialog").boundingBox()).width < 600) {
          await expect(page.locator(".settings-tabs")).toBeHidden();
          await expect(page.locator(".settings-mobile-navigation")).toBeVisible();
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        await page.screenshot({ path: path.join(buildRoot, `experience-${width}-${colorScheme}-settings.png`) });
        await page.locator("#settings-cancel").click();
        await expect(page.locator("#settings-dialog")).toBeHidden();
      }
    } finally { await context.close(); }
  });
}
