import { test, expect, fs, path, root, openFixture, chooseView, primaryModifier, openSettingsDialog, openOutline } from "./fixture.mjs";
import { collaborativeLibrary } from "./collaboration-cases.mjs";

test("outline jumps reach the heading and caret without changing text in Live, Source and Read", async ({ page, browserName }) => {
  const source = "\uFEFF---\r\ntitle: Outline navigation\r\ncustom: keep\r\n---\r\n\r\n"
    + "# Same\n\n```md\n# Not a heading\n```\n\n"
    + Array.from({ length: 75 }, (_, index) => `## Section ${index}\n\nA paragraph for outline navigation.\n\n`).join("")
    + "# Same\n\nEnd.\n";
  const normalized = source.slice(1).replace(/\r\n/g, "\n");
  await openFixture(page, "Outline-navigation.md", source, "Outline navigation");
  await page.locator("#outline-tab").click();
  const first = page.locator("#outline-list").getByRole("button", { name: "Same", exact: true }).first();
  const last = page.locator("#outline-list").getByRole("button", { name: "Same", exact: true }).last();
  const target = page.locator(".ProseMirror #same-2");
  await last.click();
  await expect(target).toBeInViewport();
  await expect(page.locator(".ProseMirror")).toBeFocused();
  expect(await page.evaluate(() => {
    const anchor = document.getSelection().anchorNode;
    return (anchor.nodeType === Node.ELEMENT_NODE ? anchor : anchor.parentElement).closest("h1")?.id;
  })).toBe("same-2");
  await first.click();
  await expect(page.locator(".ProseMirror #same")).toBeInViewport();
  await last.focus();
  await last.press("Enter");
  await expect(target).toBeInViewport();
  await expect(page.locator("#editor")).toHaveValue(normalized);
  if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath("outline-live-jump.png"), caret: "initial" });

  await chooseView(page, "editor");
  await openOutline(page);
  await last.click();
  expect(await page.locator("#editor").evaluate(node => node.selectionStart)).toBe(normalized.lastIndexOf("# Same"));
  expect(await page.locator("#editor").evaluate(node => node.scrollTop)).toBeGreaterThan(0);
  await chooseView(page, "preview");
  await expect(page.locator("#preview #same-2")).toBeAttached();
  await openOutline(page);
  await first.click();
  await last.click();
  const visible = await page.locator("#preview #same-2").evaluate(node => new Promise(resolve => {
    requestAnimationFrame(() => {
      const rect = node.getBoundingClientRect();
      const viewport = document.getElementById("preview").getBoundingClientRect();
      resolve(rect.bottom > viewport.top && rect.top < viewport.bottom);
    });
  }));
  expect(visible).toBe(true);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  expect(await fs.readFile(path.join(root, "Outline-navigation.md"), "utf8")).toBe(source);
});

test("virtual Source outline jumps reveal the exact wrapped target without edits", async ({ page, browserName }) => {
  const paragraph = "A long wrapped source paragraph for precise outline positioning. ".repeat(5) + "\n\n";
  const source = Array.from({ length: 512 }, (_, index) => `## Heading ${index}\n\n${paragraph.repeat(4)}`).join("");
  await fs.writeFile(path.join(root, "Outline-virtual.md"), source);
  await chooseView(page, "editor");
  await page.locator("#refresh-files").click();
  await page.locator('#file-list button[data-path="Outline-virtual.md"]').click();
  await expect(page.locator(".virtual-source-editor .cm-content")).toBeVisible();
  await page.locator("#outline-tab").click();
  await page.locator("#outline-list").getByRole("button", { name: "Heading 511", exact: true }).click();
  await expect(page.locator(".cm-line").filter({ hasText: /^## Heading 511$/ })).toBeInViewport();
  await expect(page.locator(".virtual-source-editor .cm-content")).toBeFocused();
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  expect(await fs.readFile(path.join(root, "Outline-virtual.md"), "utf8")).toBe(source);
  if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath("outline-virtual-jump.png"), caret: "initial" });
});

test("native Source outline reveals wrapped text without losing undo or disabled navigation", async ({ page, browserName }) => {
  const source = "# Start\n\n" + ("A long wrapped source paragraph for accurate navigation. ".repeat(12) + "\n\n").repeat(120)
    + "## Wrapped target\n\nEnd.\n";
  await fs.writeFile(path.join(root, "Outline-native.md"), source);
  await chooseView(page, "editor");
  await page.locator("#refresh-files").click();
  await page.locator('#file-list button[data-path="Outline-native.md"]').click();
  const editor = page.locator("#editor");
  await expect(editor).toBeVisible();
  await page.locator("#outline-tab").click();
  const target = page.locator("#outline-list").getByRole("button", { name: "Wrapped target", exact: true });
  const atEnd = () => editor.evaluate(node => {
    const style = getComputedStyle(node);
    return node.scrollHeight - node.clientHeight - node.scrollTop
      <= parseFloat(style.paddingBottom) + parseFloat(style.lineHeight) * 5;
  });
  await target.click();
  await expect.poll(atEnd).toBe(true);
  expect(await editor.evaluate(node => node.selectionStart)).toBe(source.lastIndexOf("## Wrapped target"));
  await editor.evaluate(node => { node.scrollTop = 0; });
  await target.evaluate(node => node.click());
  await expect.poll(atEnd).toBe(true);
  await editor.evaluate(node => { node.disabled = true; node.scrollTop = 0; });
  await target.click();
  await expect.poll(atEnd).toBe(true);
  await editor.evaluate(node => { node.disabled = false; });
  await editor.focus();
  await page.keyboard.insertText("X");
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(editor).toHaveValue(source);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  expect(await fs.readFile(path.join(root, "Outline-native.md"), "utf8")).toBe(source);
  if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath("outline-native-jump.png"), caret: "initial" });
});

test("Live code scrollbars initialize on use and are released when switching files", async ({ page, browserName }) => {
  const source = "# Deferred code widgets\n\n"
    + "```js\nconst value = 1;\n```\n\n".repeat(32)
    + '```js\nconst message = "' + "x".repeat(320) + '";\n```\n';
  await openFixture(page, "Deferred-code.md", source);
  const blocks = page.locator(".folio-code-scroll");
  await expect(blocks).toHaveCount(33);
  await expect(page.locator(".folio-code-scroll > .os-scrollbar")).toHaveCount(0);
  const last = blocks.last();
  const oldHost = await last.elementHandle();
  const viewport = last.locator("pre");
  const before = await viewport.evaluate(node => ({ width: node.clientWidth, height: node.clientHeight }));
  await viewport.hover();
  await expect(last.locator(".os-scrollbar-horizontal")).toHaveCount(1);
  expect(await viewport.evaluate(node => ({ width: node.clientWidth, height: node.clientHeight }))).toEqual(before);
  await page.mouse.wheel(300, 0);
  await expect.poll(() => viewport.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
  await expect(page.locator("#editor")).toHaveValue(source);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  if (browserName !== "webkit") await page.screenshot({
    path: test.info().outputPath("deferred-code-scrollbar.png"), caret: "initial",
  });
  await page.emulateMedia({ forcedColors: "active" });
  await expect(page.locator(".folio-code-scroll > .os-scrollbar-horizontal")).toHaveCount(33);
  await page.emulateMedia({ forcedColors: "none" });
  await page.locator('#file-list button[data-path="Second.md"]').click();
  await expect(page.locator(".ProseMirror h1")).toHaveText("Second");
  expect(await oldHost.evaluate(node => node.isConnected)).toBe(false);
  await expect(page.locator(".folio-code-scroll")).toHaveCount(0);
  expect(await fs.readFile(path.join(root, "Deferred-code.md"), "utf8")).toBe(source);
});

test("a rejected history update keeps the previous file, source and editor consistent", async ({ page }) => {
  const before = await page.locator("#editor").inputValue();
  const url = page.url();
  await page.evaluate(() => {
    window.originalHistoryPush = window.history.pushState;
    window.history.pushState = () => { throw new DOMException("History update denied", "SecurityError"); };
  });
  await page.locator('#file-list button[data-path="Second.md"]').click();
  await expect(page.locator("#document-message")).toContainText("History update denied");
  await expect(page.locator("#editor")).toHaveValue(before);
  await expect(page.locator(".ProseMirror h1")).toHaveText("Welcome");
  await expect(page.locator('#file-list button[data-path="README.md"]')).toHaveAttribute("aria-current", "page");
  expect(page.url()).toBe(url);
  await page.evaluate(() => { window.history.pushState = window.originalHistoryPush; });
  await page.locator('#file-list button[data-path="Second.md"]').click();
  await expect(page.locator(".ProseMirror h1")).toHaveText("Second");
  await expect(page.locator("#editor")).toHaveValue("# Second\n\nAnother note.\n");
});

test("cached Markdown bodies keep per-file links, fresh history and external changes", async ({ page }) => {
  const folders = ["Cache-scope-a", "Cache-scope-b"];
  const source = "# Shared body\n\n[Target](target.md)\n\nOriginal.\n";
  for (const folder of folders) {
    await fs.mkdir(path.join(root, folder));
    await fs.writeFile(path.join(root, folder, "note.md"), source);
    await fs.writeFile(path.join(root, folder, "target.md"), `# ${folder}\n`);
  }
  try {
    await page.locator("#refresh-files").click();
    await page.locator('#file-list button[data-path="Cache-scope-a/note.md"]').click();
    await expect(page.locator(".ProseMirror h1")).toHaveText("Shared body");
    const firstLink = await page.locator(".ProseMirror a").getAttribute("href");
    await page.locator(".ProseMirror h1").click();
    await page.keyboard.press("End");
    await page.keyboard.insertText(" edited");
    await page.keyboard.press(`${primaryModifier}+z`);
    await expect(page.locator("#editor")).toHaveValue(source);
    await page.locator('#file-list button[data-path="Cache-scope-b/note.md"]').click();
    await expect(page.locator(".ProseMirror h1")).toHaveText("Shared body");
    await page.locator(".ProseMirror").focus();
    await page.keyboard.press(`${primaryModifier}+Shift+z`);
    await expect(page.locator("#editor")).toHaveValue(source);
    const secondLink = await page.locator(".ProseMirror a").getAttribute("href");
    expect(secondLink).not.toBe(firstLink);
    await page.locator(".ProseMirror a").click({ modifiers: [primaryModifier] });
    await expect(page.locator(".ProseMirror h1")).toHaveText("Cache-scope-b");
    await fs.writeFile(path.join(root, "Cache-scope-a/note.md"), "# External update\n\nFresh body.\n");
    await page.locator('#file-list button[data-path="Cache-scope-a/note.md"]').click();
    await expect(page.locator(".ProseMirror h1")).toHaveText("External update");
    await expect(page.locator("#editor")).toHaveValue("# External update\n\nFresh body.\n");
    await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  } finally {
    for (const folder of folders) await fs.rm(path.join(root, folder), { recursive: true, force: true });
  }
});

test("unsupported bodies stay in Source across repeated Live attempts without losing content", async ({ page }) => {
  const sources = [
    "# Footnote\n\nText[^1].\n\n[^1]: Original footnote.\n",
    "# References\n\n[unused]: Other.md\n",
  ];
  for (const [index, source] of sources.entries()) {
    const filename = `Unsupported-cache-${index}.md`;
    await fs.writeFile(path.join(root, filename), source);
    await chooseView(page, "editor");
    await page.locator("#refresh-files").click();
    await page.locator(`#file-list button[data-path="${filename}"]`).click();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await chooseView(page, "rich");
      await expect(page.locator("#document-panes")).toHaveAttribute("data-view", "editor");
      await expect(page.locator("#view-label")).toHaveText("Source");
      await expect(page.locator("#rich-warning")).toBeVisible();
      await expect(page.locator("#editor")).toHaveValue(source);
      await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    }
    expect(await fs.readFile(path.join(root, filename), "utf8")).toBe(source);
  }
});

test("round-trip validation preserves canonical and noncanonical bodies through editing and undo", async ({ page }) => {
  for (const [index, body] of [
    "# Title\n\nPlain text.\n",
    "# Title\n\nPlain text.\n\n\n",
    "# Title\n\n```text\nliteral  \n\n```\n\n",
    "# Title\n\n<div>literal\n\ncontent</div>\n\n",
  ].entries()) {
    await openFixture(page, `Roundtrip${index}.md`, body);
    const heading = page.locator(".ProseMirror h1").first();
    await heading.click();
    await page.keyboard.press("End");
    await page.keyboard.insertText("X");
    await expect(heading).toHaveText("TitleX");
    if (body.includes("literal  ")) await expect(page.locator("#editor")).toHaveValue(/literal  \n/);
    if (body.includes("<div>")) await expect(page.locator("#editor")).toHaveValue(/<div>literal\n\ncontent<\/div>/);
    await page.keyboard.press(`${primaryModifier}+z`);
    await expect(heading).toHaveText("Title");
    await chooseView(page, "editor");
    await expect(page.locator("#editor")).toHaveValue(body);
  }
});

test("Live headings keep Rust-compatible anchors through typing and undo without duplicate source updates", async ({ page, browserName }) => {
  const content = "# Same\n\n# Same-2\n\n# Same\n\n## 你好 世界\n\nBody.\n";
  await openFixture(page, "Heading-anchors.md", content);
  const live = page.locator(".ProseMirror");
  await page.locator("#outline-tab").click();
  const ids = () => live.locator("h1, h2").evaluateAll((nodes) => nodes.map((node) => node.id));
  expect(await ids()).toEqual(["same", "same-2", "same-3", "你好-世界"]);
  await live.locator("h1").first().click();
  await page.keyboard.press("End");
  await page.evaluate(() => {
    window.headingSourceUpdates = 0;
    document.getElementById("editor").addEventListener("input", () => { window.headingSourceUpdates += 1; });
  });
  await page.keyboard.insertText("X");
  await expect(live.locator("h1").first()).toHaveText("SameX");
  await expect(page.locator('#outline-list [aria-current="location"]')).toHaveText("SameX");
  await live.locator("p").last().click();
  await expect(page.locator('#outline-list [aria-current="location"]')).toHaveText("你好 世界");
  expect(await ids()).toEqual(["samex", "same-2", "same", "你好-世界"]);
  expect(await page.evaluate(() => window.headingSourceUpdates)).toBe(1);
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(live.locator("h1").first()).toHaveText("Same");
  expect(await ids()).toEqual(["same", "same-2", "same-3", "你好-世界"]);
  await chooseView(page, "preview");
  await expect(page.locator("#preview h1")).toHaveCount(3);
  expect(await page.locator("#preview h1, #preview h2").evaluateAll((nodes) => nodes.map((node) => node.id)))
    .toEqual(["same", "same-2", "same-3", "你好-世界"]);
  await chooseView(page, "editor");
  await expect(page.locator("#editor")).toHaveValue(content);
  await chooseView(page, "rich");
  await live.locator("p").last().click();
  await expect(page.locator('#outline-list [aria-current="location"]')).toHaveText("你好 世界");
  if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath("live-outline-light.png"), animations: "disabled", caret: "initial" });
  await page.emulateMedia({ colorScheme: "dark" });
  if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath("live-outline-dark.png"), animations: "disabled", caret: "initial" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(live).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath("live-outline-narrow.png"), animations: "disabled", caret: "initial" });
});

test("hidden previews are materialized only on demand and keep the latest saved document", async ({ page }) => {
  await chooseView(page, "editor");
  await openFixture(page, "Deferred.md", `# Deferred preview\n\n${"A long paragraph.\n\n".repeat(120)}`);
  await chooseView(page, "editor");
  await expect(page.locator("#preview h1")).toHaveCount(0);
  let previewRequests = 0;
  page.on("request", (request) => { if (request.url().includes("/api/preview")) previewRequests += 1; });
  await chooseView(page, "preview");
  await expect(page.locator("#preview h1")).toHaveText("Deferred preview");
  expect(previewRequests).toBe(1);
  await page.locator("#preview").evaluate((node) => { node.scrollTop = 300; });
  await chooseView(page, "editor");
  await page.locator('[data-path="Second.md"]').click();
  await expect(page.locator("#document-title")).toHaveText("Second.md");
  await page.locator("#editor").fill("# Saved while hidden\n\nNew body.\n");
  await page.keyboard.press("Control+s");
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  await expect(page.locator("#preview h1")).toHaveCount(0);
  await chooseView(page, "preview");
  await expect(page.locator("#preview h1")).toHaveText("Saved while hidden");
  expect(await page.locator("#preview").evaluate((node) => node.scrollTop)).toBe(0);
  expect(previewRequests).toBe(1);
  await chooseView(page, "editor");
  await page.locator("#editor").fill("# Unsaved preview\n");
  await chooseView(page, "preview");
  await expect(page.locator("#preview h1")).toHaveText("Unsaved preview");
  expect(previewRequests).toBe(2);
});

for (const [view, label] of [["editor", "Source"], ["rich", "Live"]]) test(`${label} navigation skips HTML until preview is requested and never flashes the previous note`, async ({ page, browserName }) => {
  await chooseView(page, "preview");
  await expect(page.locator("#preview h1")).toHaveText("Welcome");
  await chooseView(page, view);
  const loaded = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === "/api/document" && url.searchParams.get("render") === "source";
  });
  let previews = 0;
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/preview") previews += 1;
  });
  await page.locator('#file-list button[data-path="Second.md"]').click();
  const payload = await (await loaded).json();
  expect(payload.html).toBeNull();
  expect(payload.content).toBe("# Second\n\nAnother note.\n");
  await expect(page.locator("#editor")).toHaveValue(payload.content);
  await expect(page.locator("#preview h1")).toHaveCount(0);
  expect(previews).toBe(0);
  await chooseView(page, "preview");
  await expect(page.locator("#preview h1")).toHaveText("Second");
  expect(previews).toBe(1);
  await chooseView(page, view);
  await chooseView(page, "preview");
  await expect(page.locator("#preview h1")).toHaveText("Second");
  expect(previews).toBe(1);
  if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath(`deferred-${label.toLowerCase()}-preview.png`), animations: "disabled", caret: "initial" });
});

test("dense Source notes virtualize below the byte threshold and retain save and undo", async ({ page }) => {
  const content = "# Dense Source\n\n" + "A line of source text.\n".repeat(5000);
  await fs.writeFile(path.join(root, "Dense-source.md"), content);
  await page.locator("#refresh-files").click();
  const note = page.locator('#file-list button[data-path="Dense-source.md"]');
  await expect(note).toBeVisible();
  await openSettingsDialog(page);
  await page.locator('[data-settings-tab="editor"]').click();
  await page.locator("#settings-line-wrap").uncheck();
  await page.locator("#settings-save").click();
  await expect(page.locator("#settings-dialog")).toBeHidden();
  await chooseView(page, "editor");
  await note.click();
  const editor = page.locator(".virtual-source-editor .cm-content");
  await expect(editor).toBeVisible();
  await expect(editor).not.toHaveClass(/cm-lineWrapping/);
  await expect(page.locator("#editor")).toBeHidden();
  await editor.focus();
  await page.keyboard.insertText("Edited 中文📝 ");
  await page.keyboard.press(`${primaryModifier}+s`);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  expect(await fs.readFile(path.join(root, "Dense-source.md"), "utf8")).toContain("Edited ");
  await page.keyboard.press(`${primaryModifier}+z`);
  await page.keyboard.press(`${primaryModifier}+s`);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  expect(await fs.readFile(path.join(root, "Dense-source.md"), "utf8")).toBe(content);
  await page.screenshot({ path: test.info().outputPath("dense-source-virtualized.png"), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: test.info().outputPath("dense-source-dark.png"), animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(editor).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("dense-source-narrow.png"), animations: "disabled" });
});

test("workspace opens from cached account data before a delayed refresh and surfaces failures", async ({ browser }) => {
  const library = await collaborativeLibrary(browser);
  let release;
  try {
    const [page] = library.pages;
    await page.locator("#more-menu > summary").click();
    await page.locator("#workspace-favorite").click();
    await expect(page.locator("#workspace-favorite")).toHaveText("Remove from favorites");
    const gate = new Promise((resolve) => { release = resolve; });
    await page.route("**/api/workspace", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      await gate;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Workspace temporarily unavailable." }) });
    });
    await page.locator("#more-menu > summary").click();
    await page.locator("#workspace-open").click();
    await expect(page.locator("#workspace-dialog")).toBeVisible();
    await expect(page.locator("#workspace-list")).toContainText("Shared");
    await page.locator("#workspace-filter").fill("Shared");
    await expect(page.locator(".workspace-item-name")).toHaveCount(1);
    release();
    await expect(page.locator("#document-message")).toContainText("Could not load your workspace");
    await expect(page.locator(".workspace-item-name")).toHaveCount(1);
  } finally { release?.(); await library.close(); }
});

test("document navigation resets Source scrolling before paint without a stale frame changing the next note", async ({ page }) => {
  await fs.writeFile(path.join(root, "Scroll-next.md"), `# Next note\n\n${"Line of source.\n".repeat(2000)}`);
  await openFixture(page, "Scroll-first.md", `# First note\n\n${"Line of source.\n".repeat(2000)}`);
  await chooseView(page, "editor");
  await page.locator("#refresh-files").click();
  const editor = page.locator("#editor");
  await editor.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await expect.poll(() => editor.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await page.locator('[data-path="Scroll-next.md"]').click();
  await expect(page.locator("#document-title")).toHaveText("Scroll-next.md");
  await expect.poll(() => editor.evaluate((node) => node.scrollTop)).toBe(0);
  await page.locator('[data-path="Scroll-first.md"]').click();
  await page.locator('[data-path="Second.md"]').click();
  await expect(page.locator("#document-title")).toHaveText("Second.md");
  await expect(editor).toHaveValue("# Second\n\nAnother note.\n");
  await expect.poll(() => editor.evaluate((node) => node.scrollTop)).toBe(0);
});
