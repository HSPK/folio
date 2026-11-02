import { test, expect, fs, path, root, openFixture, chooseView, primaryModifier, openBlockTools as openBlock } from "./fixture.mjs";
import { imageFixture } from "./node-tools-cases.mjs";

const source = 'Intro **kept**.\n\n```rust\nfn main() {\n    kept();\n}\n```\n\n'
  + '<img src="images/figure.png" alt="Figure" title="Original" style="width:40%;display:block;margin-left:auto;margin-right:auto">\n\n'
  + '> Quote **formatting**.\n>\n> Second paragraph.\n\n| Name | State |\n| --- | --- |\n| A | Draft |\n\nTail paragraph.\n';
const blockMenu = page => page.getByRole("menu", { name: "Block actions", exact: true });
const grip = page => page.locator(".folio-block-grip");

for (const width of [1440, 390]) {
  test(`shared block grips stay left, vertical and layout-neutral at ${width}px`, async ({ page, browserName }) => {
    await page.setViewportSize({ width, height: 844 });
    await imageFixture(page, `Blocks-base-${width}.md`);
    await openFixture(page, `Block-gutters-${width}.md`, source);
    for (const [selector, label] of [
      [".ProseMirror > p", "Text"], [".folio-code-block", "Code block"],
      [".folio-block-image", "Image block"], [".ProseMirror blockquote", "Quote"], [".folio-table-wrapper", "Table"],
    ]) {
      const block = page.locator(selector).first();
      await block.scrollIntoViewIfNeeded();
      const before = await block.boundingBox();
      await block.hover();
      await expect(grip(page)).toBeVisible();
      const handle = await grip(page).boundingBox();
      const add = await page.getByRole("button", { name: "Add block below", exact: true }).boundingBox();
      const viewport = await page.locator(".folio-live-scroll").boundingBox();
      expect(add.x).toBeGreaterThanOrEqual(viewport.x);
      expect(add.x + add.width).toBeLessThanOrEqual(handle.x);
      expect(handle.x).toBeGreaterThanOrEqual(viewport.x);
      expect(handle.x + handle.width).toBeLessThanOrEqual(before.x);
      expect(handle.height).toBeGreaterThan(handle.width);
      expect(await grip(page).locator("svg").evaluate(node => getComputedStyle(node).transform)).toBe("none");
      expect(await grip(page).evaluate(node => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d");
        context.fillStyle = getComputedStyle(node).backgroundColor;
        context.fillRect(0, 0, 1, 1);
        return context.getImageData(0, 0, 1, 1).data[3];
      })).toBe(255);
      const menu = await openBlock(page, block, label);
      expect(await block.boundingBox()).toEqual(before);
      await expect(menu.getByRole("searchbox")).toHaveCount(0);
      if (label === "Table") {
        await expect(menu.locator(".folio-table-export > summary")).toBeVisible();
        await expect(block.locator(".folio-table-row-grip")).toHaveCSS("opacity", "0");
        await expect(block.locator(".folio-table-selection")).toBeHidden();
      } else {
        await expect(menu.locator(".folio-block-menu-heading")).toHaveText(label);
        await expect(menu.getByRole("menuitem")).toHaveCount(2);
        await expect(menu.getByText(/Copy .*as/)).toHaveCount(0);
      }
      const popup = await menu.boundingBox();
      expect(popup.x).toBeGreaterThanOrEqual(8);
      expect(popup.x + popup.width).toBeLessThanOrEqual(width - 8);
      if (browserName !== "webkit") await page.screenshot({
        path: test.info().outputPath(`block-${label.replaceAll(" ", "-").toLowerCase()}-${width}.png`), caret: "initial",
      });
      await menu.press("Escape");
      expect(await block.boundingBox()).toEqual(before);
      await expect(page.locator("#editor")).toHaveValue(source);
    }
    await page.mouse.move(5, 5);
    await expect(grip(page)).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

for (const [selector, label] of [
  [".folio-code-block", "Code block"], [".folio-block-image", "Image block"], [".folio-table-wrapper", "Table"],
]) {
  test(`whole-block menu for ${label} preserves the caret and toggles closed without selecting content`, async ({ page }) => {
    await imageFixture(page, `Block-toggle-base-${label.replaceAll(" ", "-")}.md`);
    await openFixture(page, `Block-toggle-${label.replaceAll(" ", "-")}.md`, source);
    const editor = page.locator(".ProseMirror");
    const paragraph = editor.locator(":scope > p").first();
    await paragraph.click();
    await paragraph.evaluate(node => node.ownerDocument.getSelection().setBaseAndExtent(node.firstChild, 2, node.firstChild, 2));
    const menu = await openBlock(page, page.locator(selector), label);
    await expect(grip(page)).toHaveAttribute("aria-expanded", "true");
    await expect(editor.locator(".ProseMirror-selectednode, .selectedCell")).toHaveCount(0);
    await expect(editor.locator(".folio-table-selection")).toBeHidden();
    await expect(page.locator("#editor")).toHaveValue(source);
    await grip(page).click();
    await expect(menu).toBeHidden();
    await expect(grip(page)).toHaveAttribute("aria-expanded", "false");
    await expect(editor).toBeFocused();
    await page.keyboard.insertText("X");
    await expect(paragraph).toHaveText("InXtro kept.");
    await page.keyboard.press(`${primaryModifier}+z`);
    await expect(page.locator("#editor")).toHaveValue(source);
    await openBlock(page, page.locator(selector), label);
    await menu.press("Escape");
    await expect(editor).toBeFocused();
    await page.keyboard.insertText("Y");
    await expect(paragraph).toHaveText("InYtro kept.");
  });
}

test("a block menu preserves a text range and closes on an outside pointer without a selection change", async ({ page }) => {
  await openFixture(page, "Block-menu-text-range.md", "Intro.\n\n```rust\nkept();\n```\n\nTail.\n");
  const editor = page.locator(".ProseMirror");
  const paragraph = editor.locator(":scope > p").first();
  await paragraph.click();
  await paragraph.evaluate(node => node.ownerDocument.getSelection().setBaseAndExtent(node.firstChild, 1, node.firstChild, 4));
  const menu = await openBlock(page, page.locator(".folio-code-block"), "Code block");
  expect(await page.evaluate(() => document.getSelection().toString())).toBe("ntr");
  await grip(page).click();
  await page.keyboard.insertText("X");
  await expect(paragraph).toHaveText("IXo.");
  await openBlock(page, page.locator(".folio-code-block"), "Code block");
  await paragraph.dispatchEvent("pointerdown", { button: 0, buttons: 1 });
  await expect(menu).toBeHidden();
  await expect(page.locator("#folio-block-tools")).toHaveAttribute("inert", "");
  await expect(paragraph).toHaveText("IXo.");
});

test("block plus can insert below an open menu without selecting or replacing its block", async ({ page }) => {
  await openFixture(page, "Block-menu-plus.md", "Before.\n\n```rust\nkept();\n```\n\nAfter.\n");
  const code = page.locator(".folio-code-block");
  const menu = await openBlock(page, code, "Code block");
  await page.getByRole("button", { name: "Add block below", exact: true }).click();
  await expect(menu).toBeHidden();
  await expect(page.locator(".ProseMirror")).toBeFocused();
  await page.keyboard.insertText("Added.");
  await expect(code.locator("code")).toHaveText("kept();");
  await expect(code.locator("xpath=following-sibling::*[1]")).toHaveText("Added.");
});

test("block menus duplicate, delete and undo whole code, image and quote blocks and persist their attributes", async ({ page }) => {
  await imageFixture(page, "Block-actions-base.md");
  await openFixture(page, "Block-actions.md", source);
  for (const [selector, label] of [
    [".folio-code-block", "Code block"], [".folio-block-image", "Image block"], [".ProseMirror blockquote", "Quote"],
  ]) {
    const blocks = page.locator(selector);
    let menu = await openBlock(page, blocks.first(), label);
    await menu.getByRole("menuitem", { name: "Duplicate block", exact: true }).click();
    await expect(blocks).toHaveCount(2);
    if (label === "Code block") {
      for (const block of await blocks.all()) await expect(block).toHaveAttribute("data-language", "rust");
      await expect(blocks.locator("code")).toHaveText(["fn main() {\n    kept();\n}", "fn main() {\n    kept();\n}"]);
    } else if (label === "Image block") {
      for (const image of await blocks.all()) {
        await expect(image).toHaveAttribute("data-layout", "center");
        await expect(image.locator("img")).toHaveAttribute("alt", "Figure");
        await expect(image.locator("img")).toHaveAttribute("title", "Original");
      }
    } else await expect(blocks.locator("strong")).toHaveText(["formatting", "formatting"]);
    menu = await openBlock(page, blocks.first(), label);
    await menu.getByRole("menuitem", { name: "Delete block", exact: true }).click();
    await expect(blocks).toHaveCount(1);
    await page.keyboard.press(`${primaryModifier}+z`);
    await expect(blocks).toHaveCount(2);
    await page.keyboard.press(`${primaryModifier}+z`);
    await expect(blocks).toHaveCount(1);
    await expect(page.locator("#editor")).toHaveValue(source);
  }
  await (await openBlock(page, page.locator(".folio-code-block"), "Code block"))
    .getByRole("menuitem", { name: "Delete block", exact: true }).click();
  for (const [selector, label] of [[".folio-block-image", "Image block"], [".ProseMirror blockquote", "Quote"]]) {
    await (await openBlock(page, page.locator(selector), label))
      .getByRole("menuitem", { name: "Duplicate block", exact: true }).click();
  }
  await page.keyboard.press(`${primaryModifier}+s`);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  const saved = await fs.readFile(path.join(root, "Block-actions.md"), "utf8");
  expect(saved).toContain("width:40%");
  expect(saved).not.toContain("folio-block");
  expect(saved).not.toContain("fn main");
  await page.reload();
  await expect(page.locator(".folio-code-block")).toHaveCount(0);
  await expect(page.locator(".folio-block-image")).toHaveCount(2);
  for (const image of await page.locator(".folio-block-image").all()) await expect(image).toHaveAttribute("data-layout", "center");
  await expect(page.locator(".ProseMirror blockquote")).toHaveCount(2);
  await expect(page.locator(".ProseMirror blockquote strong")).toHaveText(["formatting", "formatting"]);
  await expect(page.locator(".ProseMirror > p").first()).toHaveText("Intro kept.");
  await expect(page.locator(".ProseMirror > p").last()).toHaveText("Tail paragraph.");
  await chooseView(page, "preview");
  await expect(page.locator("#preview img")).toHaveCount(2);
  await expect(page.locator("#preview blockquote")).toHaveCount(2);
  await expect(page.locator("#preview blockquote strong")).toHaveText(["formatting", "formatting"]);
});

test("nested code block menus do not duplicate the enclosing quote or break image rows", async ({ page }) => {
  await imageFixture(page, "Nested-blocks-base.md");
  const text = '> Before **kept**.\n>\n> ```rust\n> first\n> second\n> ```\n>\n> After kept.\n\n'
    + '![One](images/figure.png) ![Two](images/pixel.png)\n\nTail.\n';
  await openFixture(page, "Nested-blocks.md", text);
  const code = page.locator(".ProseMirror blockquote .folio-code-block");
  await (await openBlock(page, code, "Code block")).getByRole("menuitem", { name: "Duplicate block", exact: true }).click();
  await expect(page.locator(".ProseMirror blockquote")).toHaveCount(1);
  await expect(code).toHaveCount(2);
  await expect(code.locator("code")).toHaveText(["first\nsecond", "first\nsecond"]);
  await expect(page.locator(".ProseMirror blockquote > p").last()).toHaveText("After kept.");
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(page.locator("#editor")).toHaveValue(text);
  const row = page.locator(".folio-image-row");
  await expect(row).toHaveCount(1);
  await row.scrollIntoViewIfNeeded();
  const before = await row.locator(".folio-inline-image").evaluateAll(nodes =>
    nodes.map(node => ({ left: node.offsetLeft, top: node.offsetTop, width: node.offsetWidth, height: node.offsetHeight })));
  const menu = await openBlock(page, row, "Text");
  expect(await row.locator(".folio-inline-image").evaluateAll(nodes =>
    nodes.map(node => ({ left: node.offsetLeft, top: node.offsetTop, width: node.offsetWidth, height: node.offsetHeight })))).toEqual(before);
  await menu.getByRole("menuitem", { name: "Duplicate block", exact: true }).click();
  await expect(row).toHaveCount(2);
  await expect(page.locator(".folio-image-row .folio-inline-image")).toHaveCount(4);
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(page.locator("#editor")).toHaveValue(text);
});

test("block menus support keyboard navigation, pending pointer carets and safe view changes", async ({ page }) => {
  await openFixture(page, "Block-lifecycle.md", "Intro.\n\n```rust\nfirst\nsecond\n```\n\nTail.\n");
  const code = page.locator(".folio-code-block code");
  await page.locator(".ProseMirror > p").first().click();
  await page.locator(".ProseMirror").evaluate(dom => {
    const text = dom.querySelector("code").firstChild;
    dom.ownerDocument.getSelection().setBaseAndExtent(text, 2, text, 2);
    dom.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true }));
  });
  const menu = blockMenu(page);
  const duplicate = menu.getByRole("menuitem", { name: "Duplicate block", exact: true });
  const remove = menu.getByRole("menuitem", { name: "Delete block", exact: true });
  await expect(menu.locator(".folio-block-menu-heading")).toHaveText("Code block");
  await expect(duplicate).toBeFocused();
  await duplicate.press("ArrowUp");
  await expect(remove).toBeFocused();
  await remove.press("ArrowDown");
  await expect(duplicate).toBeFocused();
  await menu.press("Escape");
  await expect(page.locator(".ProseMirror")).toBeFocused();
  await page.keyboard.insertText("Kept ");
  await expect(code).toHaveText("fiKept rst\nsecond");
  await openBlock(page, page.locator(".folio-code-block"), "Code block");
  await chooseView(page, "editor");
  await expect(menu).toBeHidden();
  await expect(grip(page)).toBeHidden();
  await chooseView(page, "rich");
  await openBlock(page, page.locator(".folio-code-block"), "Code block");
  await page.locator('[data-path="Second.md"]').click();
  await expect(page.locator("#document-title")).toHaveText("Second.md");
  await expect(menu).toBeHidden();
  await expect(grip(page)).toBeHidden();
  await openBlock(page, page.locator(".ProseMirror > p"), "Text");
  await menu.getByRole("menuitem", { name: "Duplicate block", exact: true }).click();
  await expect(page.locator(".ProseMirror > p")).toHaveText(["Another note.", "Another note."]);
});

for (const [label, body, selector] of [
  ["Code block", "```rust\nfirst\nsecond\n```\n", ".folio-code-block"],
  ["Image block", '<img src="images/pixel.png" alt="Figure" style="width:60%;height:100px;display:block;margin-left:0;margin-right:auto">\n', ".folio-block-image"],
  ["Table", "| Name | State |\n| --- | --- |\n| A | Draft |\n", ".folio-table-wrapper"],
]) {
  for (const dismissBy of ["grip", "Escape"]) {
    test(`menu dismissal keeps the ${label} viewport when using ${dismissBy} with a distant caret`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 600 });
      await page.emulateMedia({ reducedMotion: "no-preference" });
      const source = "Origin.\n\n" + Array.from({ length: 40 }, (_, index) => `Paragraph ${index}.\n\n`).join("")
        + body + "\n" + "Tail.\n\n".repeat(20);
      await openFixture(page, `Menu-focus-${label.replaceAll(" ", "-")}-${dismissBy}.md`, source);
      const editor = page.locator(".ProseMirror");
      const origin = editor.locator(":scope > p").first();
      await origin.click();
      await origin.evaluate(node => node.ownerDocument.getSelection().setBaseAndExtent(node.firstChild, 2, node.firstChild, 2));
      await (await openBlock(page, origin, "Text")).press("Escape");
      const block = page.locator(selector);
      await block.scrollIntoViewIfNeeded();
      const menu = await openBlock(page, block, label);
      const scroller = page.locator(".folio-live-scroll");
      const before = await scroller.evaluate(node => ({ top: node.scrollTop, left: node.scrollLeft }));
      expect(before.top).toBeGreaterThan(1000);
      const trigger = await grip(page).boundingBox();
      const popup = await menu.boundingBox();
      expect(popup.x < trigger.x + trigger.width && popup.x + popup.width > trigger.x
        && popup.y < trigger.y + trigger.height && popup.y + popup.height > trigger.y).toBe(false);
      if (dismissBy === "grip") await grip(page).click();
      else await menu.press("Escape");
      await expect(page.locator(label === "Table" ? "#folio-table-tools" : "#folio-block-tools")).toBeHidden();
      await expect(editor).toBeFocused();
      const after = await scroller.evaluate(node => new Promise(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve({ top: node.scrollTop, left: node.scrollLeft })))));
      expect(after).toEqual(before);
      await expect(page.locator("#editor")).toHaveValue(source);
      await page.keyboard.insertText("X");
      await expect(origin).toHaveText("OrXigin.");
    });
  }
}

test("menu dismissal preserves both the page viewport and a horizontally scrolled code caret", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 600 });
  await openFixture(page, "Menu-focus-code-scroller.md", "Origin.\n\n" + "Paragraph.\n\n".repeat(40)
    + "```text\ncursor " + "x".repeat(600) + "\n```\n\n" + "Tail.\n\n".repeat(20));
  const block = page.locator(".folio-code-block");
  await block.scrollIntoViewIfNeeded();
  await block.locator("code").click();
  await block.locator("code").evaluate(node => node.ownerDocument.getSelection().setBaseAndExtent(node.firstChild, 2, node.firstChild, 2));
  await (await openBlock(page, block, "Code block")).press("Escape");
  const viewport = block.locator("pre");
  await viewport.evaluate(node => { node.scrollLeft = 300; });
  const menu = await openBlock(page, block, "Code block");
  const before = await page.evaluate(() => ({
    page: document.querySelector(".folio-live-scroll").scrollTop,
    code: document.querySelector(".folio-code-block pre").scrollLeft,
  }));
  expect(before.page).toBeGreaterThan(1000);
  expect(before.code).toBeGreaterThan(200);
  await menu.press("Escape");
  await expect(page.locator("#folio-block-tools")).toBeHidden();
  expect(await page.evaluate(() => ({
    page: document.querySelector(".folio-live-scroll").scrollTop,
    code: document.querySelector(".folio-code-block pre").scrollLeft,
  }))).toEqual(before);
  await page.keyboard.insertText("Kept ");
  await expect(block.locator("code")).toHaveText("cuKept rsor " + "x".repeat(600));
});

test("image preview dismissal restores focus without revealing a distant caret", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 600 });
  const source = "Origin.\n\n" + "Paragraph.\n\n".repeat(40)
    + '<img src="images/pixel.png" alt="Figure" style="width:60%;height:100px;display:block;margin-left:0;margin-right:auto">\n\n'
    + "Tail.\n\n".repeat(20);
  await openFixture(page, "Menu-focus-image-preview.md", source);
  const editor = page.locator(".ProseMirror");
  const origin = editor.locator(":scope > p").first();
  await origin.click();
  await origin.evaluate(node => node.ownerDocument.getSelection().setBaseAndExtent(node.firstChild, 2, node.firstChild, 2));
  await (await openBlock(page, origin, "Text")).press("Escape");
  await page.locator(".folio-block-image").hover();
  await page.getByRole("button", { name: "Preview image", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "Image preview", exact: true });
  await expect(preview).toBeVisible();
  const scroller = page.locator(".folio-live-scroll");
  const before = await scroller.evaluate(node => node.scrollTop);
  expect(before).toBeGreaterThan(1000);
  await preview.getByRole("button", { name: "Close image preview", exact: true }).click();
  await expect(preview).toBeHidden();
  await expect(editor).toBeFocused();
  expect(await scroller.evaluate(node => node.scrollTop)).toBe(before);
  await expect(page.locator("#editor")).toHaveValue(source);
});
