import { test, expect, fs, path, root, buildRoot, initialText, chooseView, reloadDocument, openFixture, metadataField, confirmDialog, primaryModifier } from "./fixture.mjs";

test("MkDocs metadata is separate from the formatted body and remains exact after a body edit", async ({ page, browserName }) => {
  const header = "\uFEFF---\r\n# Keep this comment\n"
    + "title: 'Metadata title'\r\ndescription: >-\n  A folded description.\r\n"
    + "tags: [one, two]\ncustom:\r\n  keep: true\r\n...\n\r\n";
  const source = `${header}# Real heading\n\nA **bold** paragraph.\r\n`;
  await openFixture(page, "Metadata.md", source, "Metadata title");
  const live = page.locator(".ProseMirror");
  await expect(live.locator("h1")).toHaveText("Real heading");
  await expect(live).not.toContainText("Metadata title");
  await expect(live.locator("hr")).toHaveCount(0);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  await expect(page.locator(".folio-metadata-caption")).toHaveText("Properties");
  await expect(page.locator(".folio-property-preview")).toHaveText("#one #two");
  await expect(page.locator(".folio-metadata-source")).toBeHidden();
  await page.locator("#outline-tab").click();
  await expect(page.locator("#outline-list")).toHaveText("Real heading");
  // Playwright's WebKit screenshot hook injects a nonce-free stylesheet.
  if (browserName !== "webkit") await page.screenshot({ path: path.join(buildRoot, "metadata-frontmatter.png"), caret: "initial" });
  await live.locator("h1").click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" updated");
  await expect(live.locator("h1")).toHaveText("Real heading updated");
  await page.keyboard.press(`${primaryModifier}+s`);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  expect((await fs.readFile(path.join(root, "Metadata.md"), "utf8")).startsWith(header)).toBeTruthy();
  const field = await metadataField(page);
  await expect(field).toHaveValue("Metadata title");
  await expect(page.locator(".folio-metadata textarea")).toHaveCount(0);
  if (browserName !== "webkit") await page.screenshot({ path: path.join(buildRoot, "metadata-frontmatter-expanded.png"), caret: "initial" });
  await chooseView(page, "preview");
  await expect(page.locator("#preview h1")).toHaveText("Real heading updated");
  await expect(page.locator("#preview")).not.toContainText("Metadata title");
});

test("editing YAML alone preserves the complete body's original spelling and newlines", async ({ page }) => {
  const source = "---\r\ntitle: 'Metadata title'\n# Preserved\n"
    + "tags:\r\n  - one\r\n  - two\n---\r\n\r\n"
    + "# Real heading\n\nKeep _this spelling_.\r\n\r\nAnother paragraph.\n";
  await openFixture(page, "Header-only.md", source, "Metadata title");
  const field = await metadataField(page);
  await field.fill((await field.inputValue()).replace("Metadata title", "Renamed title"));
  await expect(page.locator("#document-title")).toHaveText("Renamed title *");
  await expect(page).toHaveTitle("Renamed title * — Folio");
  await expect(page.locator(".ProseMirror h1")).toHaveText("Real heading");
  await page.keyboard.press("Control+s");
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  await expect(page.locator('button[data-path="Header-only.md"]')).toHaveText("Renamed title");
  expect(await fs.readFile(path.join(root, "Header-only.md"), "utf8"))
    .toBe(source.replace("Metadata title", "Renamed title"));
});

test("body undo does not discard a metadata edit", async ({ page }) => {
  const source = "---\ntitle: 'Original title'\n---\n\n# Body\n\nText.\n";
  await openFixture(page, "Metadata-undo.md", source, "Original title");
  const field = await metadataField(page);
  await field.fill((await field.inputValue()).replace("Original title", "Changed title"));
  await page.locator(".ProseMirror h1").click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" addition");
  await expect(page.locator(".ProseMirror h1")).toHaveText("Body addition");
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(page.locator(".ProseMirror h1")).toHaveText("Body");
  await page.keyboard.press(`${primaryModifier}+s`);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  expect(await fs.readFile(path.join(root, "Metadata-undo.md"), "utf8"))
    .toBe(source.replace("Original title", "Changed title"));
});

test("invalid YAML is reported without hiding the body or discarding source", async ({ page, browserName }) => {
  const header = "---\ntitle: [unfinished\n---\n\n";
  await openFixture(page, "Invalid-metadata.md", `${header}# Body\n\nText.\n`);
  const field = await metadataField(page);
  await expect(field).toBeDisabled();
  await expect(page.locator(".status-notices #metadata-message")).toBeVisible();
  await expect(page.locator("#metadata-message")).toContainText("Invalid YAML");
  await expect(page.locator("#metadata-message")).toContainText("Source mode");
  await expect(page.locator(".ProseMirror h1")).toHaveText("Body");
  await expect(page.locator("#document-panes")).toHaveAttribute("data-view", "rich");
  expect((await fs.readFile(path.join(root, "Invalid-metadata.md"), "utf8")).startsWith(header)).toBeTruthy();
  if (browserName !== "webkit") await page.screenshot({ path: path.join(buildRoot, "metadata-validation.png") });
});

test("math, empty table cells and list headings open safely in Live mode", async ({ page }) => {
  const source = "---\ntitle: 技术笔记\n---\n\n"
    + "# Techniques\n\n$$L(x)=x^2$$\n\n$$L(x)=x^2$$\n\n## 实验观察\n"
    + "- First item with $\\Vert f(o_g)-o_s\\Vert$\n"
    + "- Second item with $\\Vert f(o_g)-o_s\\Vert$\n"
    + "Evaluation\n- Down stream tasks\n\t- \n"
    + "Train Metrics\n- Reconstruction\n\n"
    + "| Model | L1 | L2 |\n| --- | --- | --- |\n| Test |  |  |\n";
  await openFixture(page, "Technical.md", source, "技术笔记");
  await expect(page.locator("#rich-warning")).toBeHidden();
  const editor = page.locator(".ProseMirror[contenteditable=true]");
  await expect(editor).toBeVisible();
  await expect(editor.locator('[data-type="math_block"]')).toHaveCount(2);
  await expect(editor.locator('[data-type="math_block"] .katex')).toHaveCount(2);
  await expect(editor.locator('[data-type="math_inline"]')).toHaveCount(2);
  await expect(editor.locator('[data-type="math_inline"] .katex')).toHaveCount(2);
  await expect.poll(() => page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].filter(f => f.family.startsWith("KaTeX") && f.status === "loaded").length;
  })).toBeGreaterThan(0);
  const inlineMath = editor.locator('[data-type="math_inline"]').first();
  await inlineMath.locator(".folio-math-output").click();
  const inlineSource = inlineMath.getByLabel("Inline TeX source");
  await expect(inlineSource).toBeVisible();
  await inlineSource.fill("x^3 + y");
  await expect(inlineMath.locator("annotation")).toHaveText("x^3 + y");
  await expect(inlineMath).toHaveAttribute("data-value", "x^3 + y");
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(inlineMath).toHaveAttribute("data-value", "\\Vert f(o_g)-o_s\\Vert");
  await expect(inlineMath.locator("annotation")).toHaveText("\\Vert f(o_g)-o_s\\Vert");
  await page.keyboard.press(`${primaryModifier}+Shift+z`);
  await expect(inlineMath).toHaveAttribute("data-value", "x^3 + y");
  await expect(inlineMath.locator("annotation")).toHaveText("x^3 + y");
  const blockMath = editor.locator('[data-type="math_block"]').first();
  await blockMath.locator(".folio-math-output").click();
  const blockSource = blockMath.getByLabel("Display TeX source");
  await expect(blockSource).toBeVisible();
  await blockSource.fill("L(x)=x^3");
  await expect(blockMath.locator("annotation")).toHaveText("L(x)=x^3");
  await expect(blockMath).toHaveAttribute("data-value", "L(x)=x^3");
  await editor.locator("h1").click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" updated");
  await chooseView(page, "editor");
  await expect(page.locator("#editor")).not.toHaveValue(/<br \/>/);
  await expect(page.locator("#editor")).toHaveValue(/\$x\^3 \+ y\$/);
  await expect(page.locator("#editor")).toHaveValue(/\$\$\s*L\(x\)=x\^3\s*\$\$/);
});

test("empty and marked formulas support direct editing and composition", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Native IME injection requires Chromium CDP.");
  const source = "# Formula edges\n\n**Before $x$ after**\n\nEmpty inline: $ $\n\n$$$$\n\nEnd.\n";
  await openFixture(page, "Formula-edges.md", source);
  const editor = page.locator(".ProseMirror[contenteditable=true]");
  await expect(editor.locator("strong [data-type=math_inline]")).toHaveCount(1);
  const inlineMath = editor.locator('[data-type="math_inline"]').nth(1);
  await inlineMath.locator(".folio-math-output").click();
  await inlineMath.getByLabel("Inline TeX source").fill("y");
  await expect(inlineMath.locator("annotation")).toHaveText("y");
  await editor.locator("h1").click();
  await expect(inlineMath).not.toHaveClass(/is-editing/);
  await expect(inlineMath.getByLabel("Inline TeX source")).toBeHidden();

  const blockMath = editor.locator('[data-type="math_block"]');
  await blockMath.locator(".folio-math-output").click();
  const blockSource = blockMath.getByLabel("Display TeX source");
  await blockSource.fill("变量");
  const cdp = await page.context().newCDPSession(page);
  await blockSource.press("End");
  await cdp.send("Input.imeSetComposition", {
    text: "测试", selectionStart: 2, selectionEnd: 2,
  });
  await cdp.send("Input.insertText", { text: "测试" });
  await expect(blockMath.locator("annotation")).toHaveText("变量测试");
  await chooseView(page, "editor");
  await expect(page.locator("#editor")).toHaveValue(/\*\*Before \$x\$ after\*\*/);
  await expect(page.locator("#editor")).toHaveValue(/Empty inline: \$y\$/);
  await expect(page.locator("#editor")).toHaveValue(/\$\$\s*变量测试\s*\$\$/);
});

test("list and table edits retain their rendered structures", async ({ page }) => {
  const live = page.locator(".ProseMirror");
  await live.locator("li p").first().click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" updated");
  await expect(live.locator("li")).toContainText("A task updated");
  await live.locator("td").first().click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" edited");
  await expect(live.locator("td").first()).toHaveText("Folio edited");
  await expect(live.locator("table")).toBeVisible();
  await expect(page.locator("#editor")).toBeHidden();
  await expect(page.locator("#document-panes")).toHaveAttribute("data-view", "rich");
});
