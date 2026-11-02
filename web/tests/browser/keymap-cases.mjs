import { test, expect, fs, path, root, openFixture, chooseView, primaryModifier } from "./fixture.mjs";

test("VS Code shortcuts edit native Source lines with independent undo and selection", async ({ page }) => {
  const original = "Alpha\nBeta\nGamma\n";
  await openFixture(page, "Native-line-keys.md", original);
  await chooseView(page, "editor");
  const source = page.locator("#editor");
  await source.focus();
  await source.evaluate(node => node.setSelectionRange(7, 7));
  await page.keyboard.press("Alt+ArrowUp");
  await expect(source).toHaveValue("Beta\nAlpha\nGamma\n");
  await page.keyboard.press("Alt+Shift+ArrowDown");
  await expect(source).toHaveValue("Beta\nBeta\nAlpha\nGamma\n");
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(source).toHaveValue("Beta\nAlpha\nGamma\n");
  await page.keyboard.press(`${primaryModifier}+Shift+z`);
  await expect(source).toHaveValue("Beta\nBeta\nAlpha\nGamma\n");
  await page.keyboard.press(`${primaryModifier}+Shift+k`);
  await expect(source).toHaveValue("Beta\nAlpha\nGamma\n");
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(source).toHaveValue("Beta\nBeta\nAlpha\nGamma\n");
  await page.keyboard.press(`${primaryModifier}+Shift+Enter`);
  await page.keyboard.insertText("Above");
  await expect(source).toHaveValue("Beta\nAbove\nBeta\nAlpha\nGamma\n");
  await page.keyboard.press(`${primaryModifier}+Enter`);
  await page.keyboard.insertText("Below");
  await expect(source).toHaveValue("Beta\nAbove\nBelow\nBeta\nAlpha\nGamma\n");
  await page.keyboard.press(`${primaryModifier}+l`);
  await expect(source).toBeFocused();
  expect(await source.evaluate(node => node.value.slice(node.selectionStart, node.selectionEnd))).toBe("Below\n");
  await page.keyboard.press(`${primaryModifier}+s`);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  expect(await fs.readFile(path.join(root, "Native-line-keys.md"), "utf8")).toContain("Above\nBelow\n");
});

test("native Source history keeps typing and composition separate from line commands and never crosses notes", async ({ page, browserName }) => {
  await openFixture(page, "Native-history-keys.md", "Alpha\nBeta\n");
  await chooseView(page, "editor");
  const source = page.locator("#editor");
  await source.focus();
  await source.evaluate(node => node.setSelectionRange(10, 10));
  await page.keyboard.insertText(" typed");
  await expect(source).toHaveValue("Alpha\nBeta typed\n");
  await page.keyboard.press("Alt+ArrowUp");
  await expect(source).toHaveValue("Beta typed\nAlpha\n");
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(source).toHaveValue("Alpha\nBeta typed\n");
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(source).toHaveValue("Alpha\nBeta\n");
  await page.keyboard.press(`${primaryModifier}+Shift+z`);
  await expect(source).toHaveValue("Alpha\nBeta typed\n");
  await source.evaluate(node => node.setSelectionRange(6, node.value.length - 1));
  if (browserName === "chromium") {
    const session = await page.context().newCDPSession(page);
    try {
      await session.send("Input.imeSetComposition", { text: "中文", selectionStart: 2, selectionEnd: 2 });
      await session.send("Input.insertText", { text: "中文" });
    } finally { await session.detach(); }
    await expect(source).toHaveValue("Alpha\n中文\n");
  } else {
    await page.keyboard.insertText("中文😊");
    await expect(source).toHaveValue("Alpha\n中文😊\n");
  }
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(source).toHaveValue("Alpha\nBeta typed\n");
  await page.locator('[data-path="Second.md"]').click();
  await expect(page.locator("#document-title")).toHaveText("Second.md");
  await expect(source).toHaveValue("# Second\n\nAnother note.\n");
  await source.focus();
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(source).toHaveValue("# Second\n\nAnother note.\n");
});

test("VS Code shortcuts move and copy Live blocks without losing formatting or undo", async ({ page }) => {
  const original = "# Heading\n\nAlpha **bold**.\n\nBeta.\n\nGamma.\n";
  await openFixture(page, "Live-line-keys.md", original);
  const prose = page.locator(".ProseMirror");
  await prose.locator("p").filter({ hasText: /^Beta\.$/ }).click();
  await page.keyboard.press("Alt+ArrowUp");
  await expect(prose.locator(":scope > p")).toHaveText(["Beta.", "Alpha bold.", "Gamma."]);
  await page.keyboard.press("Alt+Shift+ArrowDown");
  await expect(prose.locator(":scope > p")).toHaveText(["Beta.", "Beta.", "Alpha bold.", "Gamma."]);
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(prose.locator(":scope > p")).toHaveText(["Beta.", "Alpha bold.", "Gamma."]);
  await page.keyboard.press(`${primaryModifier}+Shift+k`);
  await expect(prose.locator(":scope > p")).toHaveText(["Alpha bold.", "Gamma."]);
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(prose.locator(":scope > p")).toHaveText(["Beta.", "Alpha bold.", "Gamma."]);
  await page.keyboard.press(`${primaryModifier}+Enter`);
  await page.keyboard.insertText("Inserted below.");
  await expect(prose.locator(":scope > p")).toHaveText(["Beta.", "Inserted below.", "Alpha bold.", "Gamma."]);
  await page.keyboard.press(`${primaryModifier}+Shift+Enter`);
  await page.keyboard.insertText("Inserted above.");
  await expect(prose.locator(":scope > p")).toHaveText(["Beta.", "Inserted above.", "Inserted below.", "Alpha bold.", "Gamma."]);
  await expect(prose.locator("strong")).toHaveText("bold");
  await expect(prose.locator("h1")).toHaveText("Heading");
  await page.keyboard.press(`${primaryModifier}+s`);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  await page.reload();
  await expect(prose.locator("strong")).toHaveText("bold");
  await expect(prose.locator("p")).toContainText(["Beta.", "Inserted above.", "Inserted below.", "Alpha bold.", "Gamma."]);
});

test("VS Code line shortcuts inside Live code keep the code block and its language", async ({ page }) => {
  await openFixture(page, "Code-line-keys.md", "```js\nalpha\nbeta\ngamma\n```\n\nTail.\n");
  const code = page.locator(".folio-code-block code");
  const lineHeight = await code.evaluate(node => parseFloat(getComputedStyle(node).lineHeight));
  await code.click({ position: { x: 14, y: lineHeight * 1.5 } });
  await page.keyboard.press("Alt+ArrowUp");
  await expect(code).toHaveText("beta\nalpha\ngamma");
  await page.keyboard.press(`${primaryModifier}+Shift+k`);
  await expect(code).toHaveText("alpha\ngamma");
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(code).toHaveText("beta\nalpha\ngamma");
  await expect(page.locator(".folio-code-block")).toHaveAttribute("data-language", "js");
  await expect(page.locator(".ProseMirror > p")).toHaveText("Tail.");
});

test("VS Code deletion after a quick pointer change never deletes the previously selected image", async ({ page }) => {
  await openFixture(page, "Image-line-keys.md", "![Pixel](images/pixel.png)\n\nTail.\n");
  const image = page.locator(".folio-block-image");
  await image.click();
  await page.keyboard.press(`${primaryModifier}+Enter`);
  const empty = page.locator(".ProseMirror > p").first();
  await expect(empty).toHaveText("");
  await image.click();
  await empty.click();
  await page.keyboard.press(`${primaryModifier}+Shift+k`);
  await expect(image).toHaveCount(1);
  await expect(page.locator(".ProseMirror > p")).toHaveText("Tail.");
});

test("VS Code shortcuts work in virtual Source without replacing the editor or losing large text", async ({ page }) => {
  const content = "Alpha\nBeta\nGamma\n" + Array.from({ length: 2_000 }, (_, index) =>
    `Tail ${index}: ${"padding text ".repeat(36)}\n`).join("");
  await fs.writeFile(path.join(root, "Virtual-line-keys.md"), content);
  await chooseView(page, "editor");
  await page.locator("#refresh-files").click();
  await page.locator('[data-path="Virtual-line-keys.md"]').click();
  const editor = page.locator(".virtual-source-editor .cm-content");
  await expect(editor).toBeVisible();
  const original = await editor.elementHandle();
  await editor.locator(".cm-line").filter({ hasText: /^Beta$/ }).click();
  await page.keyboard.press("Alt+ArrowUp");
  await expect(editor.locator(".cm-line").first()).toHaveText("Beta");
  await page.keyboard.press(`${primaryModifier}+Shift+Enter`);
  await page.keyboard.insertText("Above");
  await expect(editor.locator(".cm-line").first()).toHaveText("Above");
  await page.keyboard.press(`${primaryModifier}+Shift+k`);
  await expect(editor.locator(".cm-line").first()).toHaveText("Beta");
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(editor.locator(".cm-line").first()).toHaveText("Above");
  expect(await original.evaluate(node => node.isConnected && node === document.querySelector(".virtual-source-editor .cm-content"))).toBe(true);
  await page.keyboard.press(`${primaryModifier}+s`);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  const saved = await fs.readFile(path.join(root, "Virtual-line-keys.md"), "utf8");
  expect(saved).toMatch(/^Above\nBeta\nAlpha\nGamma\n/);
  expect(saved).toContain("Tail 1999:");
});
