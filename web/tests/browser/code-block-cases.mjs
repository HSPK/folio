import {
  test, expect, fs, path, root, openFixture, chooseView, primaryModifier, openBlockTools,
} from "./fixture.mjs";
import { collaborativeLibrary } from "./collaboration-cases.mjs";

const examples = [
  { language: "rs", label: "Rust", code: "fn main() {}" },
  { language: "js", label: "JavaScript", code: "const answer = 42;" },
  { language: "tsx", label: "TSX", code: "const View = () => <div />;" },
  { language: "python", label: "Python", code: "print('kept')" },
  { language: "", label: "Plain text", code: "literal <b> text" },
  { language: "custom.dsl", label: "custom.dsl", code: "custom syntax" },
  { language: "constructor", label: "constructor", code: "unchanged" },
];
const source = examples.map(item => `\`\`\`${item.language}\n${item.code}\n\`\`\`\n`).join("\n");

for (const width of [1440, 390]) {
  test(`code language labels agree in Live and Read without changing code or Markdown at ${width}px`, async ({ page, browserName }) => {
    await page.setViewportSize({ width, height: 960 });
    await openFixture(page, `Code-labels-${width}.md`, source);
    await expect(page.locator(".folio-code-language")).toHaveText(examples.map(item => item.label));
    for (const label of await page.locator(".folio-code-language").all()) {
      await expect(label).toBeVisible();
      await expect(label).toHaveAttribute("contenteditable", "false");
    }
    await expect(page.locator(".folio-code-block code")).toHaveText(examples.map(item => item.code));
    await expect(page.locator("#editor")).toHaveValue(source);
    await expect(page.locator(".folio-code-block").first().locator(".folio-code-keyword")).toHaveCount(1);
    if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath(`code-labels-live-${width}.png`) });
    await chooseView(page, "preview");
    const blocks = page.locator("#preview pre");
    await expect(blocks).toHaveCount(examples.length);
    expect(await blocks.evaluateAll(nodes => nodes.map(node => node.dataset.codeLanguage))).toEqual(examples.map(item => item.label));
    expect(await blocks.evaluateAll(nodes => nodes.map(node => getComputedStyle(node, "::before").content)))
      .toEqual(examples.map(item => JSON.stringify(item.label)));
    expect(await blocks.evaluateAll(nodes => nodes.map(node => node.textContent.replace(/\n$/, "")))).toEqual(examples.map(item => item.code));
    await expect(page.locator("#editor")).toHaveValue(source);
    expect(await fs.readFile(path.join(root, `Code-labels-${width}.md`), "utf8")).toBe(source);
    if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath(`code-labels-read-${width}.png`) });
  });
}

test("code headers stay non-editable and stable gutter nodes survive edits, duplication and undo", async ({ page }) => {
  const initial = "Before.\n\n```rust\nlet value = 1;\n```\n\nTail.\n";
  await openFixture(page, "Code-label-edit.md", initial);
  const block = page.locator(".folio-code-block");
  const language = block.locator(".folio-code-language");
  const tail = page.locator(".ProseMirror > p").last();
  await tail.click();
  const anchor = await page.evaluateHandle(() => document.getSelection().anchorNode);
  await language.click();
  expect(await anchor.evaluate(node => node === document.getSelection().anchorNode)).toBe(true);
  await expect(page.locator(".ProseMirror")).toBeFocused();
  await expect(page.locator(".ProseMirror-selectednode")).toHaveCount(0);
  const number = await block.locator(".folio-code-gutter > span").first().elementHandle();
  const code = block.locator("code");
  await code.click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" // kept");
  await expect(code).toHaveText("let value = 1; // kept");
  expect(await number.evaluate(node => node.isConnected && node === document.querySelector(".folio-code-gutter > span"))).toBe(true);
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("next();");
  await expect(block.locator(".folio-code-gutter > span")).toHaveText(["1", "2"]);
  const changed = await page.locator("#editor").inputValue();
  const menu = await openBlockTools(page, block, "Code block");
  await menu.getByRole("menuitem", { name: "Duplicate block", exact: true }).click();
  await expect(page.locator(".folio-code-language")).toHaveText(["Rust", "Rust"]);
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(page.locator(".folio-code-language")).toHaveText("Rust");
  await expect(page.locator("#editor")).toHaveValue(changed);
  await page.keyboard.press(`${primaryModifier}+s`);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  const saved = await fs.readFile(path.join(root, "Code-label-edit.md"), "utf8");
  expect(saved).toContain("```rust\nlet value = 1; // kept\nnext();");
  expect(saved).not.toContain("Code language");
  expect(saved).not.toContain("folio-code");
  await page.reload();
  await expect(language).toHaveText("Rust");
  await expect(page.locator(".folio-code-block code")).toHaveText("let value = 1; // kept\nnext();");
});

test("remote language changes update code headers in place without rebuilding the editor or line numbers", async ({ browser }) => {
  const content = "# Code\n\n```rust\nlet value = 1;\n```\n\nTail.\n";
  const library = await collaborativeLibrary(browser, { content });
  try {
    const [owner, peer] = library.pages;
    const editor = await owner.locator(".ProseMirror").elementHandle();
    const header = await owner.locator(".folio-code-language").elementHandle();
    const number = await owner.locator(".folio-code-gutter > span").elementHandle();
    await expect(owner.locator(".folio-code-language")).toHaveText("Rust");
    await chooseView(peer, "editor");
    await peer.locator("#editor").fill(content.replace("```rust", "```js"));
    await expect(owner.locator(".folio-code-language")).toHaveText("JavaScript");
    await expect(owner.locator(".folio-code-block")).toHaveAttribute("data-language", "js");
    await expect(owner.locator(".folio-code-block code")).toHaveText("let value = 1;");
    expect(await editor.evaluate(node => node.isConnected && node === document.querySelector(".ProseMirror"))).toBe(true);
    expect(await header.evaluate(node => node.isConnected && node === document.querySelector(".folio-code-language"))).toBe(true);
    expect(await number.evaluate(node => node.isConnected && node === document.querySelector(".folio-code-gutter > span"))).toBe(true);
    await chooseView(owner, "preview");
    await expect(owner.locator("#preview pre")).toHaveAttribute("data-code-language", "JavaScript");
  } finally { await library.close(); }
});
