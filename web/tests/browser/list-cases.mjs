import { test, expect, fs, path, root, openFixture, primaryModifier } from "./fixture.mjs";

for (const [name, source] of [
  ["bullet", "- First\n- Last\n"],
  ["ordered", "1. First\n2. Last\n"],
  ["nested", "- Parent\n  - First\n  - Last\n"],
]) {
  test(`Shift+Tab after the last ${name} list newline preserves the preceding marker`, async ({ page, browserName }) => {
    await openFixture(page, `List-${name}.md`, source);
    const paragraph = page.locator(".ProseMirror li > div > p").filter({ hasText: /^Last$/ });
    await paragraph.click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Shift+Tab");
    const item = paragraph.locator("..").locator("..");
    await expect(item).toHaveJSProperty("tagName", "LI");
    await expect(item).toContainText("Last");
    expect(await item.evaluate(node => getComputedStyle(node).listStyleType)).not.toBe("none");
    await expect(page.locator("#editor")).toHaveValue(/(?:^|\n)\s*(?:[*+-]|\d+\.) Last(?:\n|$)/);
    await expect(page.locator("#document-panes")).toHaveAttribute("data-view", "rich");
    if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath(`${name}-last-marker.png`), caret: "initial" });
    await page.keyboard.press(`${primaryModifier}+s`);
    await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    expect(await fs.readFile(path.join(root, `List-${name}.md`), "utf8")).toMatch(/(?:^|\n)\s*(?:[*+-]|\d+\.) Last(?:\n|$)/);
  });
}

test("Shift+Tab after a final hard line break does not remove the preceding bullet", async ({ page }) => {
  await openFixture(page, "List-hardbreak.md", "- First\n- Last\n");
  await page.locator(".ProseMirror li > div > p").filter({ hasText: /^Last$/ }).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Enter");
  const breaking = await page.locator("#editor").inputValue();
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator("#editor")).toHaveValue(/(?:^|\n)[*+-] Last/);
  await expect(page.locator(".ProseMirror li > div > p").filter({ hasText: /^Last/ })).toHaveCount(1);
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(page.locator("#editor")).toHaveValue(breaking);
  await page.keyboard.press(`${primaryModifier}+Shift+z`);
  await page.keyboard.insertText("Outside");
  await expect(page.locator(".ProseMirror > p")).toHaveText("Outside");
});

test("leaving an empty final task keeps the previous checkbox and completed state", async ({ page }) => {
  await openFixture(page, "List-task.md", "- [x] First\n- [ ] Last\n");
  await page.locator(".ProseMirror li > div > p").filter({ hasText: /^Last$/ }).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator(".folio-task-checkbox:visible")).toHaveCount(2);
  await expect(page.locator(".folio-task-checkbox:visible").first()).toBeChecked();
  await expect(page.locator("#editor")).toHaveValue(/[*+-] \[ \] Last/);
});
