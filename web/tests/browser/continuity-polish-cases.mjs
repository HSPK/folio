import { test, expect, fs, path, root, openFixture, openImageOptions, openMoreAction, primaryModifier, metadataField, openSettingsDialog } from "./fixture.mjs";
import { collaborativeLibrary } from "./collaboration-cases.mjs";
import { imageFixture } from "./node-tools-cases.mjs";

async function capture(page, name, browserName) {
  if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath(`${name}.png`), animations: "disabled" });
}

async function uiLibrary(browser, options) {
  const library = await collaborativeLibrary(browser, options);
  try {
    const [page] = library.pages;
    const preferences = await (await page.request.get(new URL("/api/preferences", library.url).href)).json();
    preferences.appearance = { theme: "system", latinFont: "sans-serif", cjkFont: "sans-serif" };
    expect((await page.request.put(new URL("/api/preferences", library.url).href, { data: preferences })).ok()).toBe(true);
    await Promise.all(library.pages.map(page => page.reload()));
    if (library.pages.length > 1) {
      for (const page of library.pages) await expect(page.locator("#collaboration-join")).toHaveAttribute("aria-pressed", "true");
    }
    return library;
  } catch (error) { await library.close(); throw error; }
}

test("image shortcuts synchronize custom layout without discarding pending dimensions", async ({ page, browserName }) => {
  await imageFixture(page, "Image-consistent.md");
  const panel = await openImageOptions(page, { custom: true });
  const width = panel.getByRole("textbox", { name: "Image width", exact: true });
  const layout = panel.getByRole("combobox", { name: "Image layout", exact: true });
  await width.fill("50%");
  await panel.getByRole("button", { name: "Image layout center", exact: true }).click();
  await expect(width).toHaveValue("50%");
  await expect(layout).toHaveValue("center");
  await capture(page, "image-consistent-custom", browserName);
  await panel.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.locator(".folio-inline-image")).toHaveAttribute("data-layout", "center");
  await expect(page.locator("#editor")).toHaveValue(/width:50%;display:block;margin-left:auto;margin-right:auto/);
  await openImageOptions(page, { custom: true });
  await panel.getByRole("button", { name: "Image width 75%", exact: true }).click();
  await expect(width).toHaveValue("75%");
  await expect(layout).toHaveValue("center");
});

test("search keeps pending results inactive and presents readable excerpts with local progress", async ({ browser, browserName }) => {
  const library = await uiLibrary(browser, { participants: 1 });
  let release;
  try {
    const [page] = library.pages;
    await page.setViewportSize({ width: 1440, height: 960 });
    await fs.writeFile(path.join(library.notes, "Zzz.md"), "---\ntitle: Quartz reference\nstatus: review\n---\n\n# Quartz\n\nA **clear** [reference](Other.md).\n");
    await page.locator("#refresh-files").click();
    await expect(page.locator('[data-path="Zzz.md"]')).toBeVisible();
    await page.locator("#sidebar-search-open").click();
    await expect(page.locator("#search-results button")).toHaveCount(3);
    await expect(page.locator("#search-results")).toHaveAttribute("aria-busy", "false");
    let started;
    const begun = new Promise(resolve => { started = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    await page.route("**/api/search", async route => {
      if (route.request().postDataJSON().query === "quartz") { started(); await held; }
      await route.continue();
    });
    await page.locator("#search-query").fill("quartz");
    await begun;
    await expect(page.locator("#search-message")).toBeVisible();
    await expect(page.locator("#search-dialog #search-message")).toContainText("Searching");
    await expect(page.locator("#status-notices #search-message")).toHaveCount(0);
    await expect(page.locator("#search-results button").first()).toBeDisabled();
    await page.locator("#search-query").press("Enter");
    await expect(page.locator("#search-dialog")).toBeVisible();
    await expect(page.locator("#document-title")).toHaveText("Shared");
    await capture(page, "search-pending", browserName);
    release();
    await expect(page.locator("#search-results button")).toHaveCount(1);
    await expect(page.locator("#search-results button")).toBeEnabled();
    await expect(page.locator(".search-snippet")).toHaveText("Quartz A clear reference.");
    await expect(page.locator(".search-snippet")).not.toContainText("title:");
    await capture(page, "search-readable", browserName);
    await page.locator("#search-query").press("Enter");
    await expect(page.locator("#document-title")).toHaveText("Quartz reference");
    await expect(page.locator(".ProseMirror")).toBeFocused();
    await page.locator("#sidebar-search-open").click();
    await page.locator("#search-field").selectOption("metadata");
    await page.locator("#search-query").fill("review");
    await expect(page.locator("#search-results button")).toHaveCount(1);
    await expect(page.locator("#search-results")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator(".search-match-field")).toHaveText("Metadata match");
    await page.locator("#search-query").press("Enter");
    await expect(page.locator(".folio-metadata-source")).toBeFocused();
  } finally { release?.(); await library.close(); }
});

test("properties edit common fields without exposing or rewriting advanced YAML", async ({ page, browserName }) => {
  const source = "---\r\n# Keep the comment\r\ntitle: 'Original'\r\nstatus: draft\r\ntags: [research, UI]\r\ncustom: {x: 1}\r\n---\r\n\r\n# Body\n\nKeep _this spelling_.\r\n";
  await openFixture(page, "Properties.md", source, "Original");
  await expect(page.locator(".folio-metadata-summary")).toHaveText("draft · research · UI");
  await page.locator(".folio-metadata > details > summary").click();
  await expect(page.locator(".folio-metadata-source")).toBeHidden();
  await page.getByRole("textbox", { name: "Document title", exact: true }).fill("Changed");
  await page.getByRole("textbox", { name: "Document status", exact: true }).fill("review");
  await page.keyboard.press(`${primaryModifier}+s`);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  expect(await fs.readFile(path.join(root, "Properties.md"), "utf8"))
    .toBe(source.replace("'Original'", "'Changed'").replace("status: draft", 'status: "review"'));
  await capture(page, "properties-desktop", browserName);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 390, height: 680 });
  await capture(page, "properties-narrow-dark", browserName);
  const raw = await metadataField(page);
  await raw.fill((await raw.inputValue()).replace('"review"', "published"));
  await expect(page.getByRole("textbox", { name: "Document status", exact: true })).toHaveValue("published");
  await expect(page.locator(".folio-metadata-summary")).toContainText("published");
});

test("structured properties remain editable only through YAML and property focus survives collaboration", async ({ browser }) => {
  const library = await uiLibrary(browser, { content: "---\ntitle: Shared\nstatus: {kind: draft}\n---\n\n# Shared\n\nText.\n" });
  try {
    const [alice, bob] = library.pages;
    await alice.locator(".folio-metadata > details > summary").click();
    await expect(alice.getByRole("textbox", { name: "Document status", exact: true })).toBeDisabled();
    const title = alice.getByRole("textbox", { name: "Document title", exact: true });
    await title.fill("A shared title");
    await expect(bob.locator("#document-title")).toContainText("A shared title");
    await expect(title).toBeFocused();
    await title.pressSequentially(" still writing");
    await expect(bob.locator("#document-title")).toContainText("still writing");
    await expect(alice.locator("#editor")).toHaveValue(/status: \{kind: draft\}/);
  } finally { await library.close(); }
});

test("sharing waits for saved permissions and acknowledges copying next to the action", async ({ browser, browserName }) => {
  const library = await uiLibrary(browser, { participants: 1 });
  try {
    const [page] = library.pages;
    await page.setViewportSize({ width: 390, height: 680 });
    await openMoreAction(page, "share-page");
    await page.locator("#sharing-level").selectOption("publicRead");
    await expect(page.locator("#sharing-copy-link")).toBeDisabled();
    await capture(page, "sharing-before-save", browserName);
    await page.locator("#sharing-save").click();
    await expect(page.locator("#sharing-public-url")).not.toHaveValue("");
    await expect(page.locator("#sharing-copy-link")).toBeEnabled();
    await page.evaluate(() => Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true, value: async text => { window.copiedSharingLink = text; },
    }));
    await page.locator("#sharing-copy-link").click();
    await expect(page.locator("#sharing-copy-link")).toHaveText("Copied");
    await expect(page.locator("#sharing-feedback")).toHaveText("Link copied.");
    expect(await page.evaluate(() => window.copiedSharingLink)).toBe(await page.locator("#sharing-public-url").inputValue());
    await capture(page, "sharing-copied", browserName);
    await page.locator("#sharing-password").fill("example");
    await expect(page.locator("#sharing-copy-link")).toBeDisabled();
    await page.route("**/api/projects", route => route.request().method() === "POST"
      ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Could not save this change." }) })
      : route.continue());
    await page.locator("#sharing-save").click();
    await expect(page.locator("#sharing-form #sharing-error")).toBeVisible();
    await expect(page.locator("#status-notices #sharing-error")).toHaveCount(0);
    await capture(page, "sharing-inline-error", browserName);
  } finally { await library.close(); }
});

test("compact toolbar prioritizes the title and navigation exposes search and workspace", async ({ browser, browserName }) => {
  const library = await uiLibrary(browser);
  try {
    const [page] = library.pages;
    await page.setViewportSize({ width: 1440, height: 960 });
    await expect(page.locator("#sidebar-search-open")).toBeVisible();
    await page.locator("#sidebar-workspace-open").click();
    await expect(page.locator("#workspace-dialog")).toBeVisible();
    await expect(page.locator("#workspace-close svg")).toBeVisible();
    await page.locator("#workspace-close").click();
    await capture(page, "navigation-desktop", browserName);
    await page.setViewportSize({ width: 390, height: 680 });
    await expect(page.locator("#collaboration-people")).toBeHidden();
    await expect(page.locator("#layout-menu")).toBeHidden();
    await expect(page.locator("#collaboration-join")).toHaveText("2 online");
    await expect.poll(async () => (await page.locator("#document-title").boundingBox()).width).toBeGreaterThan(170);
    await capture(page, "toolbar-narrow", browserName);
    await page.locator("#more-menu > summary").click();
    await page.locator("#compact-layout-menu > summary").click();
    await page.locator("#compact-layout-menu [data-page-width=wide]").click();
    await expect(page.locator("html")).toHaveAttribute("data-page-width", "wide");
    await openSettingsDialog(page);
    await page.keyboard.press("Tab");
    const cancel = page.locator("#settings-cancel");
    await cancel.focus();
    await page.keyboard.press("ArrowRight");
    await expect(cancel).toBeFocused();
    await expect(cancel).toHaveCSS("outline-style", "solid");
    await page.emulateMedia({ colorScheme: "dark" });
    await capture(page, "keyboard-focus-dark", browserName);
  } finally { await library.close(); }
});
