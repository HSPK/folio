import { test, expect, openFixture, chooseView, openBlockTools, primaryModifier } from "./fixture.mjs";

async function caretBox(page) {
  const caret = page.locator(".folio-live-caret");
  await expect(caret).toBeVisible();
  return caret.boundingBox();
}

async function glyphBox(element) {
  return element.evaluate(node => {
    const walker = node.ownerDocument.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let text;
    while (walker.nextNode()) if (walker.currentNode.nodeValue.length) text = walker.currentNode;
    const range = node.ownerDocument.createRange();
    range.setStart(text, text.nodeValue.length - 1);
    range.setEnd(text, text.nodeValue.length);
    return range.getBoundingClientRect().toJSON();
  });
}

async function expectGlyphCaret(page, element) {
  const glyph = await glyphBox(element);
  await expect.poll(async () => {
    const caret = await caretBox(page);
    return Math.abs(caret.height - glyph.height) < 0.5 && Math.abs(caret.y - glyph.y) < 1;
  }).toBe(true);
  return caretBox(page);
}

async function expectNextLineCaret(page, previous, spacing) {
  await expect.poll(async () => Math.abs((await caretBox(page)).y - previous.y - spacing)).toBeLessThan(1);
  const caret = await caretBox(page);
  expect(Math.abs(caret.height - previous.height)).toBeLessThan(0.5);
  return caret;
}

for (const width of [1440, 390]) {
  test(`Live caret keeps font-sized code carets on entered empty and filled lines at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 });
    await openFixture(page, `Code-caret-${width}.md`, "Before.\n\n```text\n\n```\n\nAfter.\n");
    const block = page.locator(".folio-code-block");
    const code = block.locator("code");
    const typography = await code.evaluate(node => {
      const style = getComputedStyle(node);
      return { size: style.fontSize, line: style.lineHeight };
    });
    const spacing = parseFloat(typography.line);
    await block.locator("pre").click();
    const empty = await caretBox(page);
    await page.keyboard.insertText("x");
    const first = await expectGlyphCaret(page, code);
    await expect(page.locator(".ProseMirror")).toHaveCSS("caret-color", "rgba(0, 0, 0, 0)");
    expect(Math.abs(empty.height - first.height)).toBeLessThan(0.5);
    await page.keyboard.press("Enter");
    const second = await expectNextLineCaret(page, first, spacing);
    await page.keyboard.insertText("y");
    const filled = await expectGlyphCaret(page, code);
    expect(Math.abs(filled.y - second.y)).toBeLessThan(0.5);
    await page.keyboard.press("Enter");
    await expectNextLineCaret(page, second, spacing);
    await page.keyboard.insertText("中文");
    await expectGlyphCaret(page, code);
    await expect(block.locator(".folio-code-gutter > span")).toHaveText(["1", "2", "3"]);
    await expect(code).toHaveCSS("font-size", typography.size);
    await expect(code).toHaveCSS("line-height", typography.line);
    await expect(page.locator(".ProseMirror .folio-live-caret, .ProseMirror .folio-caret-metrics")).toHaveCount(0);
    await page.keyboard.press(`${primaryModifier}+s`);
    await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    const saved = await page.locator("#editor").inputValue();
    expect(saved).toContain("x\ny\n中文");
    expect(saved).not.toContain("folio-caret");
    await page.reload();
    await expect(code).toHaveText("x\ny\n中文");
  });
}

test("Live caret follows paragraph hard breaks and font settings without changing line spacing", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openFixture(page, "Text-caret-fonts.md", "# Heading\n\nParagraph.\n\n```text\nx\n```\n");
  const paragraph = page.locator(".ProseMirror > p").first();
  await paragraph.click();
  await page.keyboard.press("End");
  const first = await expectGlyphCaret(page, paragraph);
  const line = await paragraph.evaluate(node => parseFloat(getComputedStyle(node).lineHeight));
  await page.keyboard.press("Shift+Enter");
  await expectNextLineCaret(page, first, line);
  await page.keyboard.insertText("y");
  await expectGlyphCaret(page, paragraph);
  const source = await page.locator("#editor").inputValue();
  for (const size of [13, 25]) {
    await page.evaluate(size => document.documentElement.style.setProperty("--document-size", `${size}px`), size);
    await expectGlyphCaret(page, paragraph);
    for (const element of [page.locator(".ProseMirror h1"), page.locator(".folio-code-block code")]) {
      await element.click();
      await page.keyboard.press("End");
      await expectGlyphCaret(page, element);
    }
    await paragraph.click();
    await paragraph.evaluate(node => {
      const text = node.lastChild;
      node.ownerDocument.getSelection().setBaseAndExtent(text, text.nodeValue.length, text, text.nodeValue.length);
    });
  }
  await expect(page.locator("#editor")).toHaveValue(source);
  await expect(page.locator(".folio-live-caret")).toHaveCSS("animation-name", "none");
});

test("Live caret respects ranges, block menus, nested scrolling and editor disposal", async ({ page }) => {
  await openFixture(page, "Caret-lifecycle.md", "```text\n" + "x".repeat(600) + "\n```\n\nTail.\n");
  const editor = page.locator(".ProseMirror");
  const block = page.locator(".folio-code-block");
  const code = block.locator("code");
  const viewport = block.locator("pre");
  await viewport.click({ position: { x: 20, y: 13 } });
  await code.evaluate(node => node.ownerDocument.getSelection().setBaseAndExtent(node.firstChild, 2, node.firstChild, 2));
  await caretBox(page);
  await viewport.evaluate(node => { node.scrollLeft = 300; });
  await expect(page.locator(".folio-live-caret")).toBeHidden();
  await viewport.evaluate(node => { node.scrollLeft = 0; });
  await caretBox(page);
  await code.evaluate(node => node.ownerDocument.getSelection().setBaseAndExtent(node.firstChild, 1, node.firstChild, 4));
  await expect(page.locator(".folio-live-caret")).toBeHidden();
  await expect(editor).not.toHaveClass(/folio-font-caret/);
  expect(await page.evaluate(() => document.getSelection().toString())).toBe("xxx");
  await code.evaluate(node => node.ownerDocument.getSelection().setBaseAndExtent(node.firstChild, 2, node.firstChild, 2));
  await caretBox(page);
  const menu = await openBlockTools(page, block, "Code block");
  await expect(page.locator(".folio-live-caret")).toBeHidden();
  await menu.press("Escape");
  await caretBox(page);
  await expect(editor).toBeFocused();
  await page.keyboard.insertText("kept");
  await expect(code).toHaveText("xxkept" + "x".repeat(598));
  await page.keyboard.press(`${primaryModifier}+s`);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  await chooseView(page, "editor");
  await expect(page.locator(".folio-live-caret")).toBeHidden();
  const cached = await page.locator(".folio-live-caret").elementHandle();
  await chooseView(page, "rich");
  await page.locator('[data-path="Second.md"]').click();
  await expect(page.locator("#document-title")).toHaveText("Second.md");
  expect(await cached.evaluate(node => node.isConnected)).toBe(false);
  await expect(page.locator(".folio-live-caret")).toHaveCount(1);
});

test("Live caret preserves native code composition and undo after a newline", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "The IME injection protocol is Chromium-only.");
  await openFixture(page, "Code-caret-ime.md", "```text\nx\n```\n\nTail.\n");
  const code = page.locator(".folio-code-block code");
  await code.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await caretBox(page);
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Input.imeSetComposition", { text: "中文注释", selectionStart: 4, selectionEnd: 4 });
    await expect(code).toHaveText("x\n中文注释");
    await expectGlyphCaret(page, code);
    await session.send("Input.insertText", { text: "中文注释" });
  } finally { await session.detach(); }
  await expect(code).toHaveText("x\n中文注释");
  await expect(page.locator("#editor")).toHaveValue(/x\n中文注释/);
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(code).not.toContainText("中文注释");
  await expect(page.locator(".ProseMirror .folio-caret-metrics")).toHaveCount(0);
});
