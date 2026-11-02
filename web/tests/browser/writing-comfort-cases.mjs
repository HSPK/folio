import {
  test, expect, fs, path, root, openFixture, chooseView, primaryModifier,
  openSettingsDialog, openTableTools,
} from "./fixture.mjs";
import { collaborativeLibrary } from "./collaboration-cases.mjs";

async function capture(page, name, browserName) {
  if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath(`${name}.png`), animations: "disabled" });
}

test("link selection stays native and editing requires an explicit action", async ({ page, browserName }) => {
  const source = "Visit https://example.com/guide for details.\n\nContinue writing here.\n";
  await openFixture(page, "Link-selection.md", source);
  const link = page.locator(".ProseMirror a");
  await link.click();
  await expect(page.locator(".folio-link-dialog")).toBeHidden();
  await expect(page.locator(".ProseMirror")).toBeFocused();
  await expect(page.getByRole("toolbar", { name: "Link actions" })).toBeVisible();
  await capture(page, "lightweight-link-actions", browserName);
  const box = await link.boundingBox();
  await page.mouse.move(box.x + 12, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 15, box.y + box.height / 2, { steps: 12 });
  const selected = await page.evaluate(() => document.getSelection().toString());
  expect(selected.length).toBeGreaterThan(5);
  await page.mouse.up();
  await expect(page.locator(".folio-link-dialog")).toBeHidden();
  await expect(page.getByRole("toolbar", { name: "Link actions" })).toBeHidden();
  expect(await page.evaluate(() => document.getSelection().toString())).toBe(selected);
  await capture(page, "native-url-selection", browserName);
  await page.keyboard.press(`${primaryModifier}+k`);
  await page.locator("#command-query").fill("Edit current link");
  await page.locator("#command-query").press("Enter");
  await expect(page.locator(".folio-link-dialog")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Link target" })).toHaveValue("https://example.com/guide");
  expect(await fs.readFile(path.join(root, "Link-selection.md"), "utf8")).toBe(source);
});

test("new notes save the current text first without a discard prompt", async ({ page, browserName }) => {
  await openFixture(page, "Save-before-new.md", "# Draft\n\nCurrent text.\n");
  await page.locator(".ProseMirror p").click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" Keep this edit.");
  await page.locator("#new-note").click();
  await expect(page.locator("#new-note-dialog")).toBeVisible();
  await expect(page.locator("#confirmation-dialog")).toBeHidden();
  await expect(page.locator("#document-modified")).toBeHidden();
  expect(await fs.readFile(path.join(root, "Save-before-new.md"), "utf8")).toContain("Keep this edit.");
  await capture(page, "saved-before-new-note", browserName);
});

test("navigation waits for an in-flight save and does not require a second click", async ({ page }) => {
  await chooseView(page, "editor");
  let started;
  let release;
  const begun = new Promise(resolve => { started = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  let writes = 0;
  await page.route("**/api/document", async route => {
    if (route.request().method() !== "PUT") return route.continue();
    writes++;
    started();
    await held;
    await route.continue();
  });
  try {
    await page.locator("#editor").fill("# Saved before leaving\n");
    await page.keyboard.press(`${primaryModifier}+s`);
    await begun;
    await expect(page.locator("#new-note")).toBeEnabled();
    await page.locator('[data-path="Second.md"]').click();
    await expect(page.locator("#document-title")).toContainText("README.md");
    release();
    await expect(page.locator("#document-title")).toHaveText("Second.md");
    expect(await fs.readFile(path.join(root, "README.md"), "utf8")).toBe("# Saved before leaving\n");
    expect(writes).toBe(1);
  } finally { release(); }
});

test("continuing to type while a transition saves cancels navigation and keeps newer edits", async ({ page }) => {
  await chooseView(page, "editor");
  let started;
  let release;
  const begun = new Promise(resolve => { started = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  await page.route("**/api/document", async route => {
    if (route.request().method() !== "PUT") return route.continue();
    started();
    await held;
    await route.continue();
  });
  try {
    await page.locator("#editor").fill("# First text\n");
    await page.locator('[data-path="Second.md"]').click();
    await begun;
    await page.locator("#editor").fill("# Newer text must remain\n");
    release();
    await expect(page.locator("#document-title")).toContainText("README.md");
    await expect(page.locator("#editor")).toHaveValue("# Newer text must remain\n");
    await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    expect(await fs.readFile(path.join(root, "README.md"), "utf8")).toBe("# Newer text must remain\n");
  } finally { release(); }
});

test("failed transition saves offer retry and keep-editing choices without losing the draft", async ({ page, browserName }) => {
  await page.setViewportSize({ width: 390, height: 680 });
  await chooseView(page, "editor");
  let writes = 0;
  await page.route("**/api/document", route => {
    if (route.request().method() !== "PUT") return route.continue();
    return ++writes === 1
      ? route.fulfill({ status: 500, json: { error: "Temporary save failure." } }) : route.continue();
  });
  await page.locator("#editor").fill("# Retry this draft\n");
  await page.locator("#sidebar-toggle").click();
  await page.locator("#new-note").click();
  const confirmation = page.locator("#confirmation-dialog");
  await expect(confirmation).toBeVisible();
  await expect(confirmation.locator("[data-confirmation-message]")).toContainText("Temporary save failure.");
  await expect(page.locator("#status-notices")).toBeHidden();
  await expect(confirmation.getByRole("button", { name: "Keep editing", exact: true })).toBeFocused();
  await expect(confirmation.getByRole("button", { name: "Discard and continue", exact: true })).not.toHaveClass(/button-primary/);
  const bounds = await confirmation.boundingBox();
  for (const button of await confirmation.locator("[data-confirmation-region] .dialog-actions > button:not([hidden])").all()) {
    const box = await button.boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width - 8);
  }
  await capture(page, "save-failure-retry", browserName);
  await page.locator("#document-message").evaluate(node => { node.textContent = "A new error arrived while confirming."; });
  await expect(page.locator("#document-message")).toBeVisible();
  await expect(page.locator("#document-message")).not.toHaveAttribute("data-status-suspended");
  await confirmation.getByRole("button", { name: "Retry save", exact: true }).click();
  await expect(page.locator("#new-note-dialog")).toBeVisible();
  await expect(confirmation).toBeHidden();
  expect(await fs.readFile(path.join(root, "README.md"), "utf8")).toBe("# Retry this draft\n");
});

test("collaborative notes are durably saved before opening note creation", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { source: true, saveDelay: 10000 });
  try {
    const [alice, bob] = library.pages;
    await alice.locator("#editor").focus();
    await alice.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
    await alice.keyboard.insertText("\nKeep the shared edit.\n");
    await expect(bob.locator("#editor")).toHaveValue(/Keep the shared edit/);
    await alice.locator("#new-note").click();
    await expect(alice.locator("#new-note-dialog")).toBeVisible();
    await expect(alice.locator("#confirmation-dialog")).toBeHidden();
    expect(await fs.readFile(path.join(library.notes, "Shared.md"), "utf8")).toContain("Keep the shared edit.");
  } finally { await library.close(); }
});

test("table hover leaves the writing viewport unchanged and dismissal survives continued typing", async ({ page, browserName }) => {
  await page.setViewportSize({ width: 390, height: 680 });
  const source = "# Writing\n\n" + "Earlier text.\n\n".repeat(24)
    + "| Item | State |\n| --- | --- |\n| A | Draft |\n| B | Review |\n\nWriting here without editing the table.\n";
  await openFixture(page, "Table-activation.md", source);
  const writer = page.locator(".ProseMirror > p").last();
  await writer.click();
  await page.mouse.move(5, 5);
  const viewport = page.locator(".folio-live-scroll");
  const before = await viewport.boundingBox();
  const tools = page.getByRole("menu", { name: "Table actions", exact: true });
  await page.locator(".ProseMirror table").hover();
  await expect(page.locator(".folio-table-open")).toHaveCount(0);
  await expect(tools).toBeHidden();
  expect(await viewport.boundingBox()).toEqual(before);
  await expect(writer).toBeInViewport();
  await capture(page, "quiet-table-hover", browserName);
  const cell = page.locator(".ProseMirror td p").last();
  await cell.click();
  await expect(tools).toBeHidden();
  expect(await viewport.boundingBox()).toEqual(before);
  await expect(page.locator(".folio-table-wrapper")).toHaveClass(/is-active/);
  const caretGeometry = () => page.evaluate(() => {
    const selection = document.getSelection();
    const range = selection.getRangeAt(0).cloneRange();
    const node = selection.anchorNode;
    if (node.nodeType === Node.TEXT_NODE && node.length) {
      const offset = Math.min(selection.anchorOffset, node.length - 1);
      range.setStart(node, offset);
      range.setEnd(node, offset + 1);
    }
    return { caret: range.getBoundingClientRect().toJSON(),
      viewport: document.querySelector(".folio-live-scroll").getBoundingClientRect().toJSON(),
      text: node.textContent };
  });
  await test.info().attach("table-reveal-geometry", { contentType: "application/json", body: JSON.stringify(await caretGeometry()) });
  await expect.poll(async () => {
    const { caret, viewport } = await caretGeometry();
    return caret.top >= viewport.top && caret.bottom <= viewport.bottom;
  }).toBe(true);
  await expect(page.locator(".ProseMirror")).toBeFocused();
  await page.keyboard.insertText(" continuing");
  await expect(tools).toBeHidden();
  await capture(page, "quiet-table-editing", browserName);
  await openTableTools(page);
  await expect(tools).toBeVisible();
  await expect(tools.getByRole("menuitemradio", { name: "Align left", exact: true })).toHaveAttribute("aria-checked", "true");
  await tools.press("Escape");
  await expect(page.locator(".ProseMirror")).toBeFocused();
  await page.keyboard.insertText(" without a toolbar");
  await expect(tools).toBeHidden();
  await openTableTools(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await capture(page, "explicit-table-tools", browserName);
});

test("settings search reveals matching controls and clearing restores the previous section", async ({ page, browserName }) => {
  await page.setViewportSize({ width: 390, height: 680 });
  await openSettingsDialog(page, { section: "appearance" });
  const content = page.locator(".settings-content");
  await content.evaluate(node => { node.scrollTop = 80; });
  const before = await content.evaluate(node => node.scrollTop);
  await page.locator("#settings-search").fill("JPEG quality");
  await expect(page.locator('[data-settings-panel="library"]')).toBeVisible();
  await expect(page.locator("#settings-image-quality")).toBeInViewport();
  await expect(page.locator("#settings-image-quality").locator("..")).toHaveAttribute("data-search-match", "");
  await expect(page.locator("#settings-search")).toBeFocused();
  await capture(page, "located-settings-match", browserName);
  await page.emulateMedia({ colorScheme: "dark" });
  await capture(page, "located-settings-match-dark", browserName);
  await page.locator("#settings-search").fill("");
  await expect(page.locator('[data-settings-panel="appearance"]')).toBeVisible();
  expect(await content.evaluate(node => node.scrollTop)).toBeCloseTo(before, 0);
  await expect(page.locator("#settings-dialog [data-search-match]")).toHaveCount(0);
});

test("filtered navigation explains the hidden current note and duplicate titles have stable paths", async ({ page, browserName }) => {
  await openFixture(page, "Origin-comfort.md", "# Origin\n\n[Second](Second.md)\n");
  await page.locator("#file-filter").fill("Origin-comfort");
  await page.locator(".ProseMirror a").click({ modifiers: [primaryModifier] });
  await expect(page.locator("#document-title")).toHaveText("Second.md");
  await expect(page.locator("#file-filter")).toHaveValue("Origin-comfort");
  await expect(page.locator("#filtered-current-note")).toContainText("outside this filter");
  await capture(page, "filtered-current-note-context", browserName);
  await page.getByRole("button", { name: "Show current note", exact: true }).click();
  await expect(page.locator("#file-filter")).toHaveValue("");
  await expect(page.locator('[data-path="Second.md"]')).toHaveAttribute("aria-current", "page");
  for (const name of ["Meeting-a.md", "Meeting-b.md"]) await fs.writeFile(path.join(root, name), "---\ntitle: Meeting notes\n---\n\nBody.\n");
  await page.locator("#refresh-files").click();
  for (const name of ["Meeting-a.md", "Meeting-b.md"]) {
    await expect(page.locator(`.file-button[data-path="${name}"] .file-path`)).toBeVisible();
    await expect(page.locator(`.file-button[data-path="${name}"] .file-path`)).toHaveText(name);
  }
  await capture(page, "disambiguated-note-titles", browserName);
  await page.locator('[data-path="Meeting-a.md"]').click();
  await page.locator(".folio-metadata > details > summary").click();
  await page.getByRole("textbox", { name: "Document title", exact: true }).fill("Distinct title");
  await page.keyboard.press(`${primaryModifier}+s`);
  await expect(page.locator('[data-path="Meeting-a.md"] .file-name')).toHaveText("Distinct title");
  await expect(page.locator('[data-path="Meeting-b.md"] .file-path')).toBeHidden();
  await expect(page.locator('[data-path="Meeting-b.md"]')).toHaveText("Meeting notes");
});
