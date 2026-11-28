import { test, expect, openFixture } from "./fixture.mjs";

async function pressBelowDocument(page) {
  const scroller = page.locator(".folio-live-scroll");
  await scroller.evaluate(node => node.scrollTo(0, node.scrollHeight));
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
  await page.keyboard.press("Control+End");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.insertText("!");
  await expect(code).toHaveText("const a = 1;\nconst b = 2;!");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.insertText("After arrow");
  await expect(page.locator(".ProseMirror > p").last()).toHaveText("After arrow");
  await expect(code).toHaveText("const a = 1;\nconst b = 2;!");

  await code.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(code).toHaveText("const a = 1;\nconst b = 2;!\n\n");
  await page.keyboard.press("Enter");
  await expect(code).toHaveText("const a = 1;\nconst b = 2;!");
  await page.keyboard.insertText("After enter");
  await expect(page.locator(".ProseMirror > p").nth(0)).toHaveText("After enter");
  await expect(page.locator("#editor")).toHaveValue(
    "# Code\n\n```js\nconst a = 1;\nconst b = 2;!\n```\n\nAfter enter\n\nAfter arrow\n",
  );
});
