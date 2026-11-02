import { test, expect, fs, path, root, openFixture, chooseView, primaryModifier, metadataField, openLinkOptions, openTableTools } from "./fixture.mjs";
import { imageFixture } from "./node-tools-cases.mjs";

async function capture(page, name, browserName) {
  if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath(`${name}.png`), animations: "disabled" });
}

test("view switching preserves source selections and the reading position after source edits", async ({ page, browserName }) => {
  const content = "# Long note\n\n" + Array.from({ length: 70 }, (_, i) => `Paragraph ${i}: Writing stays here.\n\n`).join("");
  await openFixture(page, "View-continuity.md", content);
  const paragraph = page.locator(".ProseMirror p").filter({ hasText: /^Paragraph 45:/ });
  await paragraph.click();
  const anchor = await page.evaluate(() => document.getSelection().anchorNode.textContent);
  expect(anchor).toContain("Paragraph 45");
  await chooseView(page, "editor");
  await expect(page.locator("#editor")).toBeFocused();
  expect(await page.locator("#editor").evaluate(node => node.value.slice(0, node.selectionStart).split("\n").at(-1))).toContain("Paragraph 45");
  await page.keyboard.insertText(" inserted");
  await chooseView(page, "rich");
  await expect(page.locator(".ProseMirror")).toBeFocused();
  await expect.poll(() => page.evaluate(() => document.getSelection().anchorNode?.textContent)).toContain("Paragraph 45");
  await capture(page, "retained-live-position", browserName);
  await chooseView(page, "preview");
  await expect(page.locator("#preview p").filter({ hasText: /^Paragraph 45:/ })).toBeInViewport();
  await page.locator("#preview p").filter({ hasText: /^Paragraph 55:/ }).evaluate(node => {
    const root = document.getElementById("preview");
    root.scrollTop += node.getBoundingClientRect().top - root.getBoundingClientRect().top - 25;
  });
  await chooseView(page, "editor");
  expect(await page.locator("#editor").evaluate(node => node.value.slice(node.selectionStart, node.selectionStart + 20))).toContain("Paragraph 55");
});

test("file menus keep keyboard navigation on the selected object and unchanged rename is disabled", async ({ page, browserName }) => {
  await openFixture(page, "Named.md", "---\ntitle: Display title\n---\n\n# Body\n", "Display title");
  const file = page.locator('[data-path="Named.md"]');
  await file.click({ button: "right" });
  await expect(page.locator("#file-details")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("#file-rename")).toBeFocused();
  await capture(page, "file-menu-target-focus", browserName);
  await page.keyboard.press("Enter");
  await expect(page.locator("#rename-title")).toHaveText("Rename file");
  await expect(page.locator("#rename-hint")).toContainText("not the display title");
  await expect(page.locator("#confirm-rename")).toBeDisabled();
  await page.locator("#rename-path").fill("Other-name.md");
  await expect(page.locator("#confirm-rename")).toBeEnabled();
  await capture(page, "explicit-file-rename", browserName);
  await page.locator("#confirm-rename").click();
  await expect(page.locator('[data-path="Other-name.md"]')).toHaveText("Display title");
  await fs.mkdir(path.join(root, "A folder"));
  await page.locator("#refresh-files").click();
  await page.locator('summary[data-entry-path="A folder"]').click({ button: "right" });
  await expect(page.locator("#file-rename")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator('summary[data-entry-path="A folder"]')).toBeFocused();
});

test("automatic links work while typing, after paste and in Read without affecting code", async ({ page, browserName }) => {
  const externalRequests = [];
  page.on("request", request => {
    if (!["127.0.0.1", "localhost"].includes(new URL(request.url()).hostname)) externalRequests.push(request.url());
  });
  await openFixture(page, "Auto-links.md", "");
  const editor = page.locator(".ProseMirror");
  await editor.focus();
  await editor.pressSequentially("https://example.com/a ");
  await expect(editor.locator("a")).toHaveText("https://example.com/a");
  await expect(editor.locator("a")).toHaveAttribute("href", "https://example.com/a");
  await page.keyboard.insertText("www.example.org person@example.com");
  await expect(editor.locator("a")).toHaveCount(3);
  await expect(editor.locator('a[href="mailto:person@example.com"]')).toHaveText("person@example.com");
  await editor.evaluate(node => {
    const data = new DataTransfer();
    data.setData("text/plain", " https://pasted.example/path");
    node.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
  });
  await expect(editor.locator("a")).toHaveCount(4);
  await capture(page, "automatic-live-links", browserName);
  await page.keyboard.press(`${primaryModifier}+s`);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  await chooseView(page, "preview");
  await expect(page.locator("#preview a")).toHaveCount(4);
  await openFixture(page, "Existing-links.md", "https://example.com www.example.org person@example.com\n\n`https://code.example`\n\n```text\nwww.code.example\n```\n");
  await expect(editor.locator("a")).toHaveCount(3);
  expect(await fs.readFile(path.join(root, "Existing-links.md"), "utf8"))
    .toBe("https://example.com www.example.org person@example.com\n\n`https://code.example`\n\n```text\nwww.code.example\n```\n");
  await chooseView(page, "preview");
  await expect(page.locator("#preview a")).toHaveCount(3);
  await expect(page.locator("#preview code a")).toHaveCount(0);
  await openFixture(page, "Chinese-links.md", "访问 https://example.com，继续写作。");
  await expect(editor.locator("a")).toHaveText("https://example.com");
  await expect(editor.locator("a")).toHaveAttribute("href", /^https:\/\/example.com\/?$/);
  await chooseView(page, "preview");
  await expect(page.locator("#preview a")).toHaveText("https://example.com");
  await openFixture(page, "Math-links.md", "$x$ next ");
  await editor.locator("p").click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" https://example.net");
  await expect(editor.locator("a")).toHaveText("https://example.net");
  await expect(editor.locator(".folio-math-inline")).toContainText("x");
  expect(externalRequests).toEqual([]);
});

test("link options edit destinations and distinguish unavailable notes without raw filesystem errors", async ({ page, browserName }) => {
  await openFixture(page, "Link-options.md", "[Example](https://example.com)\n\n[[Future note]]\n");
  const dialog = await openLinkOptions(page);
  await dialog.getByRole("textbox", { name: "Link target" }).fill("javascript:alert(1)");
  await expect(dialog.getByRole("button", { name: "Open", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Copy link", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog.locator("form > [role=alert]")).toContainText("valid link");
  await capture(page, "invalid-link-target", browserName);
  await expect(page.locator(".ProseMirror a").first()).toHaveAttribute("href", /^https:\/\/example.com\/?$/);
  await dialog.getByRole("textbox", { name: "Link target" }).fill("https://example.org/new");
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.locator(".ProseMirror a").first()).toHaveAttribute("href", "https://example.org/new");
  await openLinkOptions(page, page.locator(".folio-wiki-link"));
  await expect(dialog).toContainText("unavailable");
  await expect(dialog.getByRole("button", { name: "Open", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Create note", exact: true })).toBeVisible();
  await expect(page.locator("#document-message")).not.toContainText("os error");
  await page.setViewportSize({ width: 390, height: 680 });
  await page.emulateMedia({ colorScheme: "dark" });
  await capture(page, "unavailable-note-actions", browserName);
  await dialog.getByRole("button", { name: "Create note", exact: true }).click();
  await expect(page.locator("#new-note-title")).toHaveValue("Future note");
  await page.locator("#create-note").click();
  await expect(page.locator("#document-title")).toHaveText("Future note");
  expect(await fs.readFile(path.join(root, "Link-options.md"), "utf8")).toContain("https://example.org/new");
});

test("table editing is undoable and contextual handles never shrink the writing viewport", async ({ page, browserName }) => {
  await page.setViewportSize({ width: 390, height: 680 });
  await openFixture(page, "Editable-table.md", "| Item | State |\n| --- | --- |\n| A | Draft |\n| B | Review |\n\nFollowing text must remain readable while editing the table.\n");
  const tools = page.getByRole("menu", { name: "Table actions", exact: true });
  const viewport = page.locator(".folio-live-scroll");
  const before = await viewport.boundingBox();
  await page.locator(".ProseMirror td p").first().click();
  await expect(tools).toBeHidden();
  await openTableTools(page, 0, "row");
  await tools.getByRole("menuitem", { name: "Insert below", exact: true }).click();
  await expect(page.locator(".ProseMirror tr")).toHaveCount(4);
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(page.locator(".ProseMirror tr")).toHaveCount(3);
  await page.locator(".ProseMirror td p").first().click();
  await openTableTools(page);
  await tools.getByRole("menuitemradio", { name: "Align center", exact: true }).click();
  await expect(page.locator(".ProseMirror th").first()).toHaveCSS("text-align", "center");
  await openTableTools(page);
  await tools.getByRole("menuitem", { name: "Insert right", exact: true }).click();
  await expect(page.locator(".ProseMirror th")).toHaveCount(3);
  await page.locator(".ProseMirror th p").first().click();
  await openTableTools(page, 0, "row");
  await tools.getByRole("menuitem", { name: "Insert above", exact: true }).click();
  await expect(page.locator(".ProseMirror tr")).toHaveCount(4);
  await expect(page.locator(".ProseMirror p").filter({ hasText: /^Following/ })).toBeInViewport();
  expect(await viewport.boundingBox()).toEqual(before);
  await openTableTools(page);
  const bounds = await tools.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(8);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(382);
  await page.emulateMedia({ colorScheme: "dark" });
  await capture(page, "table-contextual-editing", browserName);
});

test("empty notes expose insertion hints and common blocks are available from slash and commands", async ({ page, browserName }) => {
  await openFixture(page, "Insertions.md", "");
  const editor = page.locator(".ProseMirror");
  await expect(editor.locator("p")).toHaveAttribute("data-placeholder", /type \//);
  await capture(page, "empty-writing-hint", browserName);
  await editor.focus();
  await editor.pressSequentially("/task");
  await page.locator("#folio-slash-menu").getByRole("option", { name: "Task list", exact: true }).click();
  await expect(editor.locator(".folio-task-checkbox")).toBeVisible();
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(editor).toContainText("/task");
  await openFixture(page, "Formula-insertion.md", "");
  await page.keyboard.press(`${primaryModifier}+k`);
  await page.locator("#command-query").fill("formula");
  await page.locator("#command-query").press("Enter");
  await expect(editor.locator(".folio-math-block")).toBeVisible();
  await capture(page, "formula-command", browserName);
});

test("slash image insertion preserves its query until a file is chosen and supports one-step undo", async ({ page }) => {
  const image = await imageFixture(page, "Image-upload-source.md");
  await openFixture(page, "Slash-image.md", "");
  const editor = page.locator(".ProseMirror");
  await editor.focus();
  await editor.pressSequentially("/image");
  const choosing = page.waitForEvent("filechooser");
  await page.locator("#folio-slash-menu").getByRole("option", { name: "Image", exact: true }).click();
  const picker = await choosing;
  await expect(editor).toHaveText("/image");
  await picker.setFiles({ name: "figure.png", mimeType: "image/png", buffer: image });
  await expect(editor.locator(".folio-block-image")).toHaveCount(1);
  await expect(editor).not.toContainText("/image");
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(editor).toHaveText("/image");
});

test("view switching retains an active YAML selection", async ({ page }) => {
  const source = "---\ntitle: Properties\nstatus: draft\n---\n\nBody.\n";
  await openFixture(page, "Metadata-location.md", source, "Properties");
  const raw = await metadataField(page);
  await raw.focus();
  await raw.evaluate(node => { const at = node.value.indexOf("draft"); node.setSelectionRange(at, at + 5); node.dispatchEvent(new Event("select")); });
  await chooseView(page, "editor");
  expect(await page.locator("#editor").evaluate(node => node.value.slice(node.selectionStart, node.selectionEnd))).toBe("draft");
  await chooseView(page, "rich");
  await expect(raw).toBeFocused();
});
