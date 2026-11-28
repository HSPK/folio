import { test, expect, openFixture, documentEndShortcut } from "./fixture.mjs";

test("typing and Enter follow a native caret before selectionchange reaches the editor", async ({ page }) => {
  for (const key of ["x", "Shift+Enter"]) {
    await openFixture(page, "Native-caret.md", "First.\n\nLast.\n");
    const editor = page.locator(".ProseMirror");
    await editor.focus();
    await editor.evaluate(node => {
      window.holdNativeSelection = event => event.stopImmediatePropagation();
      document.addEventListener("selectionchange", window.holdNativeSelection, true);
      const last = node.lastElementChild.firstChild;
      document.getSelection().setBaseAndExtent(last, 2, last, 2);
    });
    try {
      await page.keyboard.press(key);
      await expect(editor.locator(":scope > p").first()).toHaveText("First.");
      await expect(editor.locator(":scope > p").first().locator("br")).toHaveCount(0);
      if (key === "x") await expect(editor.locator(":scope > p").last()).toHaveText("Laxst.");
      else await expect(editor.locator(":scope > p").last().locator("br")).toHaveCount(1);
    } finally {
      await page.evaluate(() => document.removeEventListener("selectionchange", window.holdNativeSelection, true));
    }
  }
});

async function pressBelowDocument(page) {
  const scroller = page.locator(".folio-live-scroll");
  await page.locator(".ProseMirror > :last-child").scrollIntoViewIfNeeded();
  await scroller.evaluate(node => node.scrollTo({ top: node.scrollHeight, behavior: "instant" }));
  const bounds = await scroller.boundingBox();
  const end = await page.locator(".ProseMirror").boundingBox();
  expect(end.y + end.height).toBeLessThan(bounds.y + bounds.height - 12);
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height - 8);
}

test("pressing the blank page after the last block continues writing at the end", async ({ page }) => {
  const source = "# Continue\n\n" + Array.from({ length: 40 }, (_, index) => `Paragraph ${index}.\n\n`).join("");
  await openFixture(page, "Continue-writing.md", source);
  await pressBelowDocument(page);
  await expect(page.locator(".ProseMirror")).toBeFocused();
  await page.keyboard.insertText(" Still here.");
  await expect(page.locator(".ProseMirror p").last()).toHaveText("Paragraph 39. Still here.");
  await expect(page.locator("#editor")).toHaveValue(source.replace("Paragraph 39.", "Paragraph 39. Still here."));

  // The side margin places the caret on the line beside it instead of dropping focus.
  const line = await page.locator(".ProseMirror p").last().boundingBox();
  const frame = await page.locator(".folio-live-scroll").boundingBox();
  await page.mouse.click(frame.x + frame.width - 40, line.y + line.height / 2);
  await expect(page.locator(".ProseMirror")).toBeFocused();
  await page.keyboard.insertText(" Margin.");
  await expect(page.locator(".ProseMirror p").last()).toHaveText("Paragraph 39. Still here. Margin.");
});

test("a trailing code block can be left by pointer, Arrow Down and a second empty line", async ({ page }) => {
  await openFixture(page, "Leave-code.md", "# Code\n\n```js\nconst a = 1;\n```\n");
  const code = page.locator(".ProseMirror .folio-code-block code");
  await pressBelowDocument(page);
  await page.keyboard.insertText("After pointer");
  await expect(page.locator(".ProseMirror > p").last()).toHaveText("After pointer");
  await expect(code).toHaveText("const a = 1;");
  await expect(page.locator("#editor")).toHaveValue("# Code\n\n```js\nconst a = 1;\n```\n\nAfter pointer\n");

  await openFixture(page, "Leave-code-keys.md", "# Code\n\n```js\nconst a = 1;\nconst b = 2;\n```\n");
  await code.click();
  await page.keyboard.press(documentEndShortcut);
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.insertText("!");
  await expect(code).toHaveText("const a = 1;\nconst b = 2;!");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.insertText("After arrow");
  await expect(page.locator(".ProseMirror > p").last()).toHaveText("After arrow");
  await expect(code).toHaveText("const a = 1;\nconst b = 2;!");

  await expect(page.locator("#editor")).toHaveValue("# Code\n\n```js\nconst a = 1;\nconst b = 2;!\n```\n\nAfter arrow\n");
  await openFixture(page, "Leave-code-enter.md", "# Code\n\n```js\nconst a = 1;\nconst b = 2;!\n```\n");
  await code.click();
  await page.keyboard.press(documentEndShortcut);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(code).toHaveJSProperty("textContent", "const a = 1;\nconst b = 2;!\n\n");
  await page.keyboard.press("Enter");
  await expect(code).toHaveJSProperty("textContent", "const a = 1;\nconst b = 2;!");
  await page.keyboard.insertText("After enter");
  await expect(page.locator(".ProseMirror > p").nth(0)).toHaveText("After enter");
  await expect(page.locator("#editor")).toHaveValue(
    "# Code\n\n```js\nconst a = 1;\nconst b = 2;!\n```\n\nAfter enter\n",
  );
});
