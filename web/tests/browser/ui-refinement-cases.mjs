import { test, expect, fs, path, buildRoot, openSettingsDialog, openMoreAction, selectSettingsSection } from "./fixture.mjs";
import { collaborativeLibrary } from "./collaboration-cases.mjs";

for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }]) {
test(`settings are inside the distinct More menu at ${viewport.width}px`, async ({ page, browserName }) => {
  await page.setViewportSize(viewport);
  const menu = page.locator("#more-menu");
  const trigger = menu.locator(":scope > summary");
  const settings = menu.locator("#settings-open");
  await expect(page.locator(".document-actions > #settings-open")).toHaveCount(0);
  await expect(settings).toHaveText("Settings");
  await expect(settings).toBeHidden();
  const bounds = await trigger.boundingBox();
  expect(bounds.width).toBeGreaterThanOrEqual(32);
  expect(bounds.height).toBeGreaterThanOrEqual(32);
  await expect(trigger.locator("svg")).toHaveCSS("width", "20px");
  expect(await trigger.locator("svg").evaluate(node => parseFloat(getComputedStyle(node).strokeWidth))).toBeGreaterThan(2);

  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(trigger).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    if (browserName !== "webkit") await page.screenshot({
      path: test.info().outputPath(`more-trigger-${theme}-${viewport.width}.png`), animations: "disabled",
    });
    if (theme === "light") {
      await trigger.focus();
      await page.keyboard.press("Enter");
      await settings.focus();
      await page.keyboard.press("Escape");
      await expect(menu).not.toHaveAttribute("open", "");
      await expect(trigger).toBeFocused();
      await page.keyboard.press("Enter");
    } else await trigger.click();
    await expect(settings).toBeVisible();
    if (browserName !== "webkit") await page.screenshot({
      path: test.info().outputPath(`more-menu-${theme}-${viewport.width}.png`), animations: "disabled",
    });
    if (theme === "light") {
      await settings.focus();
      await page.keyboard.press("Enter");
    } else await settings.click();
    await expect(page.locator("#settings-dialog")).toBeVisible();
    await expect(menu).not.toHaveAttribute("open", "");
    await expect(page.locator("#settings-search")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator("#settings-dialog")).toBeHidden();
    await expect(trigger).toBeFocused();
  }
});
}

test("visual refinement walkthrough covers workspace controls at desktop and narrow sizes", async ({ browser }) => {
  const content = "---\ntitle: 设计与研究 · Design notes\ntags: [research, UI, collaboration]\nstatus: draft\n---\n\n"
    + "# Design notes\n\nA quiet workspace for ideas, decisions, and the next small step.\n\n"
    + "## Today\n\n- [ ] Review navigation and spacing\n- [x] Keep notes in plain Markdown\n\n"
    + "## Reference\n\n[[Other|Related note]] and inline math $x^2 + y^2$.\n\n"
    + "| Area | Goal |\n| --- | --- |\n| Typography | Clear hierarchy |\n| Layout | Consistent spacing |\n";
  const library = await collaborativeLibrary(browser, { content });
  const anonymous = await browser.newContext();
  const output = path.join(buildRoot, "ui-refinement", process.env.FOLIO_UI_CAPTURE ?? "current");
  const geometry = [];
  try {
    await fs.mkdir(output, { recursive: true });
    const [page] = library.pages;
    const preferences = await (await page.request.get(new URL("/api/preferences", library.url).href)).json();
    preferences.appearance = { theme: "system", latinFont: "sans-serif", cjkFont: "sans-serif" };
    const configured = await page.request.put(new URL("/api/preferences", library.url).href, { data: preferences });
    expect(configured.ok()).toBe(true);
    await page.reload();
    const faults = [];
    page.on("pageerror", (error) => faults.push(error.message));
    await page.setViewportSize({ width: 1440, height: 960 });
    await fs.mkdir(path.join(library.notes, "Guides"), { recursive: true });
    await fs.mkdir(path.join(library.notes, "Planning"), { recursive: true });
    for (const [name, title] of [
      ["Guides/Start.md", "Getting started"],
      ["Guides/Research.md", "Research notes and longer descriptive document titles"],
      ["Planning/Weekly.md", "Weekly review"],
    ]) await fs.writeFile(path.join(library.notes, name), `---\ntitle: ${title}\ntags: [research]\n---\n\n# ${title}\n`);
    await page.locator("#refresh-files").click();
    await expect(page.locator('[data-path="Guides/Research.md"]')).toBeAttached();
    await expect(page.locator(".sidebar-footer, #library-menu, #library-name, #file-count, #root-path")).toHaveCount(0);
    await expect(page.locator(".library-actions #refresh-files")).toBeVisible();
    await page.keyboard.press("Escape");
    const capture = async (name) => {
      await page.screenshot({ path: path.join(output, `${name}.png`), animations: "disabled" });
      const measurement = await page.evaluate((name) => ({
        name, viewport: { width: innerWidth, height: innerHeight },
        bodyWidth: document.body.scrollWidth,
        panels: [...document.querySelectorAll("dialog[open], .popup[open] > .popup-panel")].map((node) => {
          const rect = node.getBoundingClientRect();
          return { id: node.id || node.parentElement.id, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }),
      }), name);
      geometry.push(measurement);
      expect(measurement.bodyWidth).toBeLessThanOrEqual(measurement.viewport.width);
      const inconsistent = await page.locator("button, summary, .popup-panel a").evaluateAll(nodes => nodes
        .filter(node => node.id !== "sidebar-scrim" && node.getClientRects().length && getComputedStyle(node).visibility !== "hidden")
        .filter(node => {
          const style = getComputedStyle(node);
          return style.borderRadius !== "6px" || style.borderBottomWidth !== style.borderTopWidth || style.boxShadow !== "none";
        }).map(node => ({ id: node.id, class: node.className, text: node.textContent.slice(0, 40) })));
      expect(inconsistent, `${name}: inconsistent controls`).toEqual([]);
      for (const panel of measurement.panels) {
        expect(panel.x, `${name}: ${panel.id} left`).toBeGreaterThanOrEqual(0);
        expect(panel.y, `${name}: ${panel.id} top`).toBeGreaterThanOrEqual(0);
        expect(panel.x + panel.width, `${name}: ${panel.id} right`).toBeLessThanOrEqual(measurement.viewport.width);
        expect(panel.y + panel.height, `${name}: ${panel.id} bottom`).toBeLessThanOrEqual(measurement.viewport.height);
      }
      if (await page.locator("#settings-dialog").isVisible()) {
        const dialog = await page.locator("#settings-dialog").boundingBox();
        const save = await page.locator("#settings-save").boundingBox();
        expect(save.y + save.height).toBeLessThan(dialog.y + dialog.height - 8);
        await page.locator("#settings-save").click({ trial: true });
        await expect(page.locator("#settings-library-label")).toHaveText("Current project");
        await expect(page.locator("#settings-library-root")).toHaveText("notes");
      }
      if (await page.locator("#search-dialog").isVisible()) {
        const dialog = await page.locator("#search-dialog").boundingBox();
        const results = await page.locator(".search-layout").boundingBox();
        expect(results.y + results.height).toBeLessThanOrEqual(dialog.y + dialog.height - 18);
        for (const id of ["search-project", "search-field"]) {
          if (!await page.locator(`#${id}`).isVisible()) continue;
          const label = await page.locator(`label[for="${id}"]`).boundingBox();
          const control = await page.locator(`#${id}`).boundingBox();
          expect(Math.abs(label.y + label.height / 2 - control.y - control.height / 2)).toBeLessThan(1);
        }
        for (const snippet of await page.locator(".search-snippet").all()) {
          expect((await snippet.boundingBox()).height).toBeLessThanOrEqual(54);
        }
      }
    };
    const openMore = id => openMoreAction(page, id);
    await capture("desktop-document");
    await page.locator(".folio-metadata > details > summary").click();
    await capture("desktop-metadata");
    await page.locator(".folio-metadata > details > summary").click();
    await page.locator("#more-menu > summary").click();
    await capture("desktop-menu");
    await page.keyboard.press("Escape");
    await openSettingsDialog(page);
    await selectSettingsSection(page, "library");
    await capture("desktop-settings");
    expect((await page.locator("#hidden-patterns").boundingBox()).height).toBeLessThan(170);
    await page.locator("#settings-cancel").click();
    await page.locator("#projects-open").click();
    await expect(page.locator('.project-open[data-project="default"]')).toHaveAttribute("aria-current", "true");
    await capture("desktop-projects");
    await page.locator("#projects-close").click();
    await openMore("share-page");
    await page.locator("#sharing-level").selectOption("publicRead");
    await capture("desktop-sharing");
    await page.locator("#sharing-cancel").click();
    await page.keyboard.press("Control+p");
    await page.locator("#search-query").fill("design");
    await expect(page.locator("#search-results")).toContainText("Design notes");
    await capture("desktop-search");
    await expect(page.locator(".search-snippet mark").first()).toBeVisible();
    await expect(page.locator(".search-snippet").first()).not.toContainText("tags:");
    await page.locator("#search-close").click();
    await openMore("history-open");
    await expect(page.locator("#history-list button")).toHaveCount(1);
    await expect(page.locator("#history-copy")).toBeEnabled();
    await capture("desktop-history");
    await page.locator("#history-close").click();
    await openMore("workspace-favorite");
    await expect(page.locator("#workspace-favorite")).toHaveText("Remove from favorites");
    await page.locator("#more-menu > summary").click();
    await capture("desktop-menu-favorite");
    await page.keyboard.press("Escape");
    await expect(page.locator("#document-tabs, #workspace-pin")).toHaveCount(0);
    await openMore("workspace-open");
    await expect(page.locator("#workspace-list")).toContainText("Design notes");
    await capture("desktop-workspace");
    await expect(page.locator(".workspace-item-name")).toHaveCSS("text-align", "left");
    const kind = await page.locator("#workspace-kind").boundingBox();
    const filter = await page.locator("#workspace-filter").boundingBox();
    expect(kind.y).toBe(filter.y);
    await page.locator("#workspace-close").click();
    await page.locator("#new-note").click();
    await page.locator("#new-note-template").selectOption("weekly");
    await capture("desktop-new-note");
    await page.locator("#cancel-new-note").click();
    await openSettingsDialog(page);
    await selectSettingsSection(page, "appearance");
    await page.locator("#settings-theme").selectOption("dark");
    await page.locator("#settings-save").click();
    await expect(page.locator("#settings-dialog")).toBeHidden();
    await page.keyboard.press("Control+p");
    await expect(page.locator("#search-results")).toContainText("Design notes");
    await capture("dark-search");
    await page.locator("#search-close").click();
    await page.locator("#projects-open").click();
    await capture("dark-projects");
    await page.locator("#projects-close").click();
    await page.setViewportSize({ width: 390, height: 680 });
    await expect(page.locator("body")).toHaveAttribute("data-sidebar", "closed");
    await capture("narrow-document");
    await page.locator("#more-menu > summary").click();
    await capture("narrow-menu");
    await page.keyboard.press("Escape");
    await openMore("share-page");
    await page.locator("#sharing-level").selectOption("publicRead");
    await capture("narrow-sharing");
    await page.locator("#sharing-cancel").click();
    await page.keyboard.press("Control+p");
    await expect(page.locator("#search-results")).toContainText("Design notes");
    await capture("narrow-search");
    const searchHeader = await page.locator("#search-title").boundingBox();
    await page.locator("#search-query").press("ArrowUp");
    await expect(page.locator("#search-results button").last()).toHaveAttribute("aria-selected", "true");
    await capture("narrow-search-last");
    expect(await page.locator("#search-title").boundingBox()).toEqual(searchHeader);
    await page.locator("#search-close").click();
    await openSettingsDialog(page);
    await selectSettingsSection(page, "library");
    await capture("narrow-settings");
    const tabs = await page.locator(".settings-mobile-navigation").boundingBox();
    const settingsContent = await page.locator(".settings-content").boundingBox();
    expect(tabs.y + tabs.height).toBeLessThanOrEqual(settingsContent.y);
    await selectSettingsSection(page, "accessibility");
    await expect(page.locator('[data-settings-panel="accessibility"]')).toBeVisible();
    await selectSettingsSection(page, "library");
    await page.locator("#settings-image-quality").scrollIntoViewIfNeeded();
    await capture("narrow-settings-bottom");
    await page.locator("#settings-save").click();
    await expect(page.locator("#settings-dialog")).not.toBeVisible();
    await page.setViewportSize({ width: 780, height: 420 });
    await page.locator("#more-menu > summary").click();
    await capture("short-menu");
    await page.locator("#more-recovery > summary").click();
    await page.locator(".more-menu-scroll").evaluate(node => { node.scrollTop = node.scrollHeight; });
    await capture("short-menu-bottom");
    await page.locator("#focus-mode").click();
    await expect(page.locator("body")).toHaveAttribute("data-focus", "true");
    await openMore("focus-mode");
    await expect(page.locator("body")).toHaveAttribute("data-focus", "false");
    await page.keyboard.press("Escape");
    await openSettingsDialog(page);
    await capture("short-settings");
    await page.locator("#settings-cancel").click();
    await page.keyboard.press("Control+p");
    await expect(page.locator("#search-results")).toContainText("Design notes");
    await capture("short-search");
    await page.locator("#search-close").click();
    const login = await anonymous.newPage();
    await login.setViewportSize({ width: 390, height: 680 });
    await login.goto(library.url);
    await expect(login.locator("#auth-screen")).toBeVisible();
    await login.screenshot({ path: path.join(output, "narrow-login.png"), animations: "disabled" });
    await fs.writeFile(path.join(output, "geometry.json"), JSON.stringify(geometry, null, 2));
    expect(faults).toEqual([]);
  } finally { await anonymous.close(); await library.close(); }
});
test("routine editing confirmations stay quiet while project errors remain visible", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { participants: 1, source: true });
  try {
    const [page] = library.pages;
    await page.locator("#projects-open").click();
    await page.getByRole("button", { name: "Manage notes", exact: true }).click();
    await page.locator("#sharing-name").fill("Research");
    const endpoint = new URL("/api/projects", library.url).href;
    const rejectSave = async route => {
      if (route.request().method() === "POST") {
        await route.fulfill({ status: 503, json: { error: "Project settings could not be saved." } });
      } else await route.continue();
    };
    await page.route(endpoint, rejectSave);
    await page.locator("#sharing-save").click();
    await expect(page.locator("#sharing-error")).toContainText("Project settings could not be saved.");
    await expect(page.locator("#sharing-error")).toContainText("could not be confirmed");
    await expect(page.locator("#sharing-error")).toHaveClass(/is-error/);
    await expect(page.locator("#projects-dialog")).toHaveAttribute("data-view", "sharing");
    await page.unroute(endpoint, rejectSave);
    await page.locator("#sharing-save").click();
    await expect(page.locator("#projects-dialog")).toHaveAttribute("data-view", "browse");
    await expect(page.locator("#projects-open")).toHaveText("Research");
    await expect(page.locator("#sharing-error")).toBeHidden();
    await expect(page.locator("#document-message")).toBeHidden();
    await page.screenshot({ path: test.info().outputPath("quiet-project-settings.png"), animations: "disabled" });
    await page.locator("#projects-close").click();
    await page.locator("#more-menu > summary").click();
    await page.locator("#document-tags-open").click();
    await page.locator("#tags-input").fill("research\nquiet");
    await page.locator("#tags-form button[type=submit]").click();
    await expect(page.locator("#tags-dialog")).toBeHidden();
    await expect(page.locator("#editor")).toHaveValue(/quiet/);
    await expect(page.locator("#document-message")).toBeHidden();
    await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    await page.locator("#new-note").click();
    await page.locator("#new-note-title").fill("Quiet note");
    await page.locator("#new-note-form button[type=submit]").click();
    await expect(page.locator("#document-title")).toHaveText("Quiet note");
    await expect(page.locator("#document-message")).toBeHidden();
    await page.locator("#new-folder").click();
    await page.locator("#new-folder-path").fill("References");
    await page.locator("#new-folder-form button[type=submit]").click();
    await expect(page.locator('#file-list .directory[data-path="References"]')).toBeVisible();
    await expect(page.locator("#document-message")).toBeHidden();
  } finally { await library.close(); }
});

test("file tree hover is immediate with separated highlights and scrollbar clearance", async ({ browser, browserName }) => {
  const library = await collaborativeLibrary(browser, { participants: 1 });
  try {
    const [page] = library.pages;
    const directory = path.join(library.notes, "Hover spacing");
    await fs.mkdir(directory);
    await Promise.all(Array.from({ length: 32 }, (_, index) =>
      fs.writeFile(path.join(directory, `Note ${String(index).padStart(2, "0")}.md`), "# Hover spacing\n\nA quiet file tree.\n")));
    const preferencesUrl = new URL("/api/preferences", page.url()).href;
    const response = await page.request.get(preferencesUrl);
    expect(response.ok(), await response.text()).toBe(true);
    const preferences = await response.json();
    preferences.appearance.latinFont = "sans-serif";
    preferences.appearance.cjkFont = "sans-serif";
    for (const theme of ["light", "dark"]) {
      preferences.appearance.theme = theme;
      preferences.web.density = theme === "dark" ? "compact" : "comfortable";
      expect((await page.request.put(preferencesUrl, { data: preferences })).ok()).toBe(true);
      await page.reload();
      const selected = page.locator('#file-list button[data-path="Hover spacing/Note 03.md"]');
      const hovered = page.locator('#file-list button[data-path="Hover spacing/Note 04.md"]');
      await selected.click();
      await expect(selected).toHaveAttribute("aria-current", "page");
      await hovered.hover();
      const geometry = await selected.evaluate(node => {
        const next = node.parentElement.nextElementSibling.querySelector(".file-button");
        const style = getComputedStyle(node);
        const nextStyle = getComputedStyle(next);
        const bar = document.querySelector("#files-scroll-frame > .os-scrollbar-vertical").getBoundingClientRect();
        return {
          gap: next.getBoundingClientRect().top + parseFloat(nextStyle.borderTopWidth)
            - node.getBoundingClientRect().bottom + parseFloat(style.borderBottomWidth),
          clearance: bar.left - node.getBoundingClientRect().right,
          clip: style.backgroundClip,
          height: node.getBoundingClientRect().height,
        };
      });
      expect(geometry.gap).toBe(2);
      expect(geometry.clearance).toBeGreaterThanOrEqual(6);
      expect(geometry.clip).toBe("padding-box");
      expect(geometry.height).toBe(theme === "dark" ? 24 : 30);
      await expect(hovered).toHaveCSS("transition-duration", "0s");
      expect(await hovered.evaluate(node => node.matches(":hover"))).toBe(true);
      expect(await hovered.evaluate(node => node.getAnimations().length)).toBe(0);
      if (browserName !== "webkit") await page.screenshot({
        path: test.info().outputPath(`${theme}-tree-hover-spacing.png`), caret: "initial",
      });
      const folder = page.locator('#file-list .directory[data-path="Hover spacing"] > summary');
      await folder.hover();
      await expect(folder.locator(".directory-actions")).toHaveCSS("opacity", "1");
      await expect(folder.locator(".directory-actions")).toHaveCSS("transition-property", "opacity");
      await expect(folder.locator(".directory-actions")).toHaveCSS("transition-duration", "0.12s");
      await expect(folder.locator("button").first()).toHaveCSS("transition-duration", "0s");
    }
  } finally { await library.close(); }
});

test("file hierarchy is compact and rapid clicks do not select navigation text", async ({ browser, browserName }) => {
  const library = await collaborativeLibrary(browser, { participants: 1 });
  let mobile;
  try {
    const [page] = library.pages;
    const entries = [
      "Planning/Weekly review.md",
      "Research/Methods/Screen time/Measures/Coding checklist.md",
      "Research/Methods/Screen time/Measures/Protocol.md",
      "Research/Methods/Screen time/Summary.md",
      "Research/Methods/Study design.md",
      "Research/Results/Forest plots.md",
    ];
    await Promise.all(entries.map(async name => {
      await fs.mkdir(path.dirname(path.join(library.notes, name)), { recursive: true });
      await fs.writeFile(path.join(library.notes, name), `# ${path.basename(name, ".md")}\n\nA compact note hierarchy.\n`);
    }));
    const preferencesUrl = new URL("/api/preferences", library.url).href;
    const preferences = await (await page.request.get(preferencesUrl)).json();
    preferences.appearance.latinFont = "sans-serif";
    preferences.appearance.cjkFont = "sans-serif";
    const protocol = page.locator('#file-list button[data-path="Research/Methods/Screen time/Measures/Protocol.md"]');
    for (const theme of ["light", "dark"]) {
      preferences.appearance.theme = theme;
      preferences.web.density = theme === "dark" ? "compact" : "comfortable";
      const updated = await page.request.put(preferencesUrl, { data: preferences });
      expect(updated.ok(), await updated.text()).toBe(true);
      await page.reload();
      await expect(protocol).toBeVisible();
      const parent = page.locator('#file-list .directory[data-path="Research"]');
      const summary = parent.locator(":scope > summary");
      const child = page.locator('#file-list .directory[data-path="Research/Methods"] > summary');
      const row = await summary.boundingBox();
      const childRow = await child.boundingBox();
      const maximumHeight = theme === "dark" ? 26 : 32;
      expect(row.height).toBeLessThanOrEqual(maximumHeight);
      expect((await protocol.boundingBox()).height).toBeLessThanOrEqual(maximumHeight);
      expect(childRow.x - row.x).toBe(8);
      await page.evaluate(() => window.getSelection().removeAllRanges());
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await summary.locator(".directory-label").dblclick({ delay: 40 });
        await expect(parent).toHaveJSProperty("open", true);
        expect(await page.evaluate(() => window.getSelection().toString())).toBe("");
      }
      await expect(page.locator("#file-list")).toHaveCSS("user-select", "none");
      await summary.focus();
      await summary.press("ArrowLeft");
      await expect(parent).toHaveJSProperty("open", false);
      await summary.press("ArrowRight");
      await expect(parent).toHaveJSProperty("open", true);
      await summary.press("ArrowDown");
      await expect(child).toBeFocused();
      await protocol.dblclick({ delay: 40 });
      await expect(page.locator("#document-title")).toContainText("Protocol.md");
      await expect(page.locator(".ProseMirror")).toContainText("A compact note hierarchy.");
      expect(await page.evaluate(() => window.getSelection().toString())).toBe("");
      await page.mouse.move(700, 700);
      if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath(`${theme}-compact-tree.png`), animations: "disabled" });
    }
    mobile = await browser.newContext({
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
      storageState: await page.context().storageState(),
    });
    const phone = await mobile.newPage();
    await phone.goto(page.url());
    await expect(phone.locator("#document-title")).toContainText("Protocol.md");
    await phone.locator("#sidebar-toggle").click();
    await expect(phone.locator("#sidebar")).toBeVisible();
    const touchRows = await phone.locator(".file-button, .directory > summary").evaluateAll(nodes =>
      nodes.filter(node => node.getClientRects().length).map(node => node.getBoundingClientRect().height));
    expect(touchRows.length).toBeGreaterThan(5);
    expect(Math.min(...touchRows)).toBeGreaterThanOrEqual(34);
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (browserName !== "webkit") await phone.screenshot({ path: test.info().outputPath("touch-compact-tree.png"), animations: "disabled" });
  } finally { await mobile?.close(); await library.close(); }
});

test("hover feedback stays neutral and stable in light and dark themes", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { participants: 1 });
  try {
    const [page] = library.pages;
    const sample = locator => locator.evaluate(node => {
      const style = getComputedStyle(node);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d");
      context.fillStyle = style.backgroundColor;
      context.fillRect(0, 0, 1, 1);
      const rect = node.getBoundingClientRect();
      return {
        rgba: [...context.getImageData(0, 0, 1, 1).data],
        color: style.color, opacity: style.opacity, transform: style.transform,
        bounds: [rect.x, rect.y, rect.width, rect.height],
      };
    });
    const neutral = rgba => expect(Math.max(...rgba.slice(0, 3)) - Math.min(...rgba.slice(0, 3))).toBeLessThanOrEqual(2);
    for (const theme of ["light", "dark"]) {
      const preferences = await (await page.request.get(new URL("/api/preferences", library.url).href)).json();
      preferences.appearance.theme = theme;
      const updated = await page.request.put(new URL("/api/preferences", library.url).href, { data: preferences });
      expect(updated.ok()).toBe(true);
      await page.reload();
      await expect(page.locator(".ProseMirror")).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const more = page.locator("#more-menu > summary");
      await page.mouse.move(700, 700);
      const toolbarBefore = await sample(more);
      await more.hover();
      await expect.poll(async () => (await sample(more)).rgba[3]).toBeGreaterThan(0);
      const toolbarAfter = await sample(more);
      neutral(toolbarAfter.rgba);
      expect(toolbarAfter.rgba[3]).toBeLessThanOrEqual(24);
      expect(toolbarAfter.color).toBe(toolbarBefore.color);
      expect(toolbarAfter.bounds).toEqual(toolbarBefore.bounds);
      expect(toolbarAfter.transform).toBe("none");
      await page.screenshot({ path: test.info().outputPath(`${theme}-toolbar-hover.png`), animations: "disabled" });
      const files = page.locator("#files-tab");
      const selectedBefore = await sample(files);
      await files.hover();
      await expect.poll(async () => (await sample(files)).rgba).toEqual(selectedBefore.rgba);
      neutral((await sample(files)).rgba);
      await page.keyboard.press("Tab");
      await more.focus();
      expect(await more.evaluate(node => node.matches(":focus-visible"))).toBe(true);
      neutral((await sample(more)).rgba);

      const projectsLoaded = page.waitForResponse(response =>
        new URL(response.url()).pathname === "/api/projects" && response.request().method() === "GET");
      await page.locator("#projects-open").click();
      await (await projectsLoaded).body();
      const manage = page.getByRole("button", { name: "Manage notes", exact: true });
      await expect(manage).toHaveCSS("opacity", "0.7");
      const opacity = (await sample(manage)).opacity;
      await page.locator(".project-open").hover();
      expect((await sample(manage)).opacity).toBe(opacity);
      neutral((await sample(page.locator(".project-open"))).rgba);
      expect((await sample(page.locator(".project-open"))).rgba[3]).toBeLessThanOrEqual(24);
      await page.screenshot({ path: test.info().outputPath(`${theme}-project-hover.png`), animations: "disabled" });
      await manage.click();
      await page.locator("#projects-title").click();
      await page.mouse.move(700, 700);
      const save = page.locator("#sharing-save");
      const primaryBefore = await sample(save);
      await save.hover();
      await page.screenshot({ path: test.info().outputPath(`${theme}-primary-hover.png`), animations: "disabled" });
      const primaryAfter = await sample(save);
      expect(primaryAfter.bounds).toEqual(primaryBefore.bounds);
      expect(primaryAfter.color).toBe(primaryBefore.color);
      expect(Math.max(...primaryAfter.rgba.slice(0, 3).map((value, index) => Math.abs(value - primaryBefore.rgba[index])))).toBeLessThanOrEqual(12);
      await page.locator("#projects-close").click();
    }
  } finally { await library.close(); }
});
