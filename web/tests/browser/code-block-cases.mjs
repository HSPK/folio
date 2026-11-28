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

test("large code block line edit frame benchmark", async ({ page }) => {
  test.skip(!process.env.FOLIO_BENCH_CODE, "Opt-in input-to-frame measurement");
  const lines = Array.from({length: 4096}, (_, i) => `row ${i + 1}`).join("\n");
  await openFixture(page, "Long code.md", "```text\n" + lines + "\n```\n");
  const block = page.locator(".folio-code-block");
  await block.locator("code").evaluate(code => {
    code.closest(".ProseMirror").focus();
    document.getSelection().collapse(code.firstChild, code.firstChild.length);
    code.closest("[data-editor-scroller]").scrollTop = code.closest("[data-editor-scroller]").scrollHeight;
  });
  const spans = await block.locator(".folio-code-gutter span").count();
  const samples = [];
  for (let i = 0; i < 16; i++) {
    await page.evaluate(() => {
      window.codeFrame = new Promise(resolve => document.addEventListener("keydown", () => {
        const start = performance.now();
        requestAnimationFrame(() => setTimeout(() => resolve(performance.now() - start), 0));
      }, { once: true, capture: true }));
    });
    await page.keyboard.press(i % 2 ? "Backspace" : "Enter");
    samples.push(await page.evaluate(() => window.codeFrame));
  }
  await expect(block.locator("code")).toHaveText(lines, {useInnerText: false});
  samples.sort((a, b) => a - b);
  console.log("CODE EDIT", process.env.FOLIO_BENCH_CODE, {spans, medianMs: samples[8], p95Ms: samples[15]});
});

test("Mermaid renders on demand in Live, Compare and Read, without changing the Markdown", async ({page}) => {
  const body = "Diagram\n\n```mermaid\nflowchart LR\n A[Start] --> B[Finish]\n```\n";
  await openFixture(page, "Diagram.md", body);
  const block = page.locator(".folio-code-block");
  const picture = block.getByRole("img", {name: "Mermaid diagram"});
  await expect(picture).toBeVisible();
  expect(await picture.evaluate(async img => {await img.decode();return img.naturalWidth})).toBeGreaterThan(80);
  await expect(block.locator("code")).toBeHidden();
  await block.getByRole("button", {name:"Show source"}).click();
  await expect(block.locator("code")).toContainText("flowchart LR");
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  await page.keyboard.insertText(" --> C[Next]");
  await expect(block.locator("code")).toContainText("C[Next]");
  await expect.poll(() => fs.readFile(path.join(root,"Diagram.md"),"utf8")).toContain("C[Next]");
  await block.getByRole("button", {name:"Hide source"}).click();
  await expect(block.locator("code")).toBeHidden();
  await chooseView(page, "split");
  await expect(page.locator("#preview folio-diagram img")).toBeVisible();
  const updated = body.replace("flowchart LR\n A[Start] --> B[Finish]", "sequenceDiagram\n Alice->>Bob: Hello");
  await page.locator("#editor").fill(updated);
  await expect.poll(() => fs.readFile(path.join(root, "Diagram.md"),"utf8")).toBe(updated);
  await chooseView(page, "preview");
  await expect(page.locator("#preview folio-diagram img")).toBeVisible();
  await expect(page.locator("#preview pre")).toBeHidden();
  await chooseView(page,"editor");
  await expect(page.locator("#editor")).toHaveValue(updated);
});

test("invalid Mermaid keeps its source readable without interrupting other diagrams", async ({page}) => {
  const body = "```mermaid\nNot a diagram\n```\n\n```mermaid\nsequenceDiagram\n A->>B: Hello\n```\n";
  await openFixture(page, "Diagram errors.md", body);
  await chooseView(page,"preview");
  const preview = page.locator("#preview");
  await expect(preview.locator("pre").first()).toBeVisible();
  await expect(preview.locator("pre").first()).toContainText("Not a diagram");
  await expect(preview.locator("img")).toBeVisible();
  expect(await fs.readFile(path.join(root,"Diagram errors.md"),"utf8")).toBe(body);
});

test("an unchanged Mermaid image survives scrolling away and back", async ({page}) => {
  await openFixture(page, "Diagram scroll.md", "```mermaid\nflowchart LR\n A --> B\n```\n\n" + "Paragraph.\n\n".repeat(100));
  const image = page.locator(".folio-code-block folio-diagram img");
  await expect(image).toBeVisible();
  const original = await image.elementHandle();
  const scroll = page.locator("[data-editor-scroller]");
  await scroll.evaluate(node => node.scrollTop = node.scrollHeight);
  await expect(image).not.toBeInViewport();
  await scroll.evaluate(node => node.scrollTop = 0);
  await expect(image).toBeInViewport();
  await page.waitForTimeout(350); // Cross the diagram's delayed visibility/render callback.
  expect(await original.evaluate(node => node.isConnected)).toBe(true);
});

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
  await expect(block.locator(".folio-code-gutter")).toHaveText("1\n2");
  const changed = await page.locator("#editor").inputValue();
  const menu = await openBlockTools(page, block, "Code block");
  await menu.getByRole("menuitem", { name: "Duplicate", exact: true }).click();
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
