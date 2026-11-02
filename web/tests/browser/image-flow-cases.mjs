import { test, expect, fs, path, root, openFixture, chooseView, primaryModifier, openImageOptions } from "./fixture.mjs";
import { imageFixture } from "./node-tools-cases.mjs";

const blockImage = (alt = "Figure", layout = "left") =>
  `<img src="images/figure.png" alt="${alt}" style="width:240px;display:block;margin-left:${layout === "left" ? "0" : "auto"};margin-right:${layout === "right" ? "0" : "auto"}">`;

async function capture(page, name, browserName) {
  if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath(`${name}.png`), caret: "initial" });
}

async function expectNativeGap(page) {
  await expect(page.locator(".ProseMirror")).toBeFocused();
  await expect(page.locator(".ProseMirror")).toHaveCSS("caret-color", "rgba(0, 0, 0, 0)");
  const gap = page.locator(".ProseMirror-gapcursor");
  await expect(gap).toHaveCSS("display", "block");
  // The zero-size widget draws the same vertical caret at every block boundary.
  await expect.poll(() => gap.evaluate(node => {
    const line = getComputedStyle(node, "::after");
    return line.visibility === "visible" && line.borderLeftWidth === "1px"
      && line.borderTopWidth === "0px" && line.width === "0px" && parseFloat(line.height) > 0;
  })).toBe(true);
}

async function openImageGap(page, name) {
  await imageFixture(page, `${name}-base.md`);
  const source = `${blockImage("First")}\n\n${blockImage("Second", "right")}\n`;
  await openFixture(page, `${name}.md`, source);
  await page.locator(".folio-block-image").first().click();
  await page.keyboard.press("ArrowRight");
  await expectNativeGap(page);
  await expect(page.locator("#editor")).toHaveValue(source);
  return page.locator(".ProseMirror");
}

for (const endOfNote of [false, true]) {
test(`block image Enter creates a real text paragraph ${endOfNote ? "at the end of the note" : "before following text"}`, async ({ page, browserName }) => {
  await imageFixture(page, "Image-caret-base.md");
  const source = blockImage() + (endOfNote ? "\n" : "\n\nTail paragraph.\n");
  await openFixture(page, endOfNote ? "Image-caret-end.md" : "Image-caret.md", source);
  const image = page.locator(".folio-block-image");
  await expect(image).toHaveAttribute("data-image-node", "block");
  await expect.poll(() => image.locator("img").evaluate(node => node.naturalWidth)).toBe(640);
  expect(await image.evaluate(node => node.parentElement.classList.contains("ProseMirror"))).toBe(true);
  await image.click();
  await expect(image).toHaveClass(/ProseMirror-selectednode/);
  await expect(page.locator(".ProseMirror")).toBeFocused();
  if (endOfNote) {
    await page.keyboard.press("ArrowRight");
    await expectNativeGap(page);
    await expect(page.locator("#editor")).toHaveValue(source);
    if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath("native-image-gap.png"), caret: "initial" });
  }
  await page.keyboard.press("Enter");
  await expect(page.locator(".ProseMirror")).toBeFocused();
  await page.keyboard.insertText("Here after the image");
  await expect(page.locator(".ProseMirror > p").first()).toHaveText("Here after the image");
  await expect(page.locator("#editor")).toHaveValue(endOfNote
    ? />\n\nHere after the image\n?$/ : />\n\nHere after the image\n\nTail paragraph/);
  await expect(page.locator(".folio-image-caret")).toHaveCount(0);
  await expect(page.locator("#editor")).not.toHaveValue(/[\u200b\u2060]/);
  if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath("native-image-text-caret.png"), caret: "initial" });
});
}

test("image navigation changes only selection and Backspace selects an image before deletion", async ({ page }) => {
  await imageFixture(page, "Image-boundaries-base.md");
  const source = `${blockImage()}\n\nTail paragraph.\n`;
  await openFixture(page, "Image-boundaries.md", source);
  const image = page.locator(".folio-block-image");
  await image.click();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".ProseMirror")).toBeFocused();
  await expect(page.locator("#editor")).toHaveValue(source);
  await page.keyboard.press("Backspace");
  await expect(image).toHaveClass(/ProseMirror-selectednode/);
  await expect(page.locator("#editor")).toHaveValue(source);
  await page.keyboard.press("Backspace");
  await expect(image).toHaveCount(0);
  await expect(page.locator(".ProseMirror")).toHaveText("Tail paragraph.");
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(page.locator("#editor")).toHaveValue(source);
});

test("native gaps between adjacent images accept keyboard text without synthetic caret nodes", async ({ page, browserName }) => {
  const prose = await openImageGap(page, "Image-between");
  await capture(page, "adjacent-image-vertical-caret", browserName);
  await page.keyboard.type("Between images");
  await expect(prose.locator(":scope > p")).toHaveText("Between images");
  await expect(prose.locator(":scope > .folio-block-image")).toHaveCount(2);
  await expect(page.locator(".folio-image-caret")).toHaveCount(0);
  if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath("adjacent-image-native-editing.png"), caret: "initial" });
});

test("Chinese IME composition starts at a native gap between adjacent images", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Native IME automation requires Chromium's composition protocol.");
  const prose = await openImageGap(page, "Image-ime");
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Input.imeSetComposition", { text: "中文图文编辑", selectionStart: 6, selectionEnd: 6 });
    await session.send("Input.insertText", { text: "中文图文编辑" });
  } finally { await session.detach(); }
  await expect(prose.locator(":scope > p")).toHaveText("中文图文编辑");
  await expect(prose.locator(":scope > .folio-block-image")).toHaveCount(2);
  await expect(page.locator(".folio-image-caret")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("native-image-chinese-composition.png"), caret: "initial" });
});

test("composition beforeinput opens a real text paragraph at an image gap", async ({ page }) => {
  const prose = await openImageGap(page, "Image-composition");
  await prose.evaluate(node => node.dispatchEvent(new InputEvent("beforeinput", {
    bubbles: true, cancelable: true, inputType: "insertCompositionText", data: "", isComposing: true,
  })));
  await expect(prose.locator(":scope > p")).toHaveCount(1);
  await page.keyboard.insertText("中文图文编辑");
  await expect(prose.locator(":scope > p")).toHaveText("中文图文编辑");
  await expect(prose.locator(":scope > .folio-block-image")).toHaveCount(2);
});

test("touch keyboard paragraph input opens a real editable line between images", async ({ page }) => {
  const prose = await openImageGap(page, "Image-touch-paragraph");
  await prose.evaluate(node => node.dispatchEvent(new InputEvent("beforeinput", {
    inputType: "insertParagraph", bubbles: true, cancelable: true,
  })));
  await expect(prose.locator(":scope > p")).toHaveCount(1);
  await page.keyboard.insertText("Continue between the images.");
  await expect(prose.locator(":scope > p")).toHaveText("Continue between the images.");
  await expect(prose.locator(":scope > .folio-block-image")).toHaveCount(2);
});

test("touch keyboard text input creates an editable paragraph at an image gap", async ({ page }) => {
  const prose = await openImageGap(page, "Image-touch-text");
  await prose.evaluate(node => node.dispatchEvent(new InputEvent("beforeinput", {
    inputType: "insertText", data: "Text between the images.", bubbles: true, cancelable: true,
  })));
  await expect(prose.locator(":scope > p")).toHaveText("Text between the images.");
  await expect(prose.locator(":scope > .folio-block-image")).toHaveCount(2);
});

test("changing an inline image to block layout and back preserves surrounding text and undo", async ({ page }) => {
  await imageFixture(page, "Image-layout-flow-base.md");
  const source = "Before![Figure](images/figure.png)After\n";
  await openFixture(page, "Image-layout-flow.md", source);
  const image = page.locator(".folio-inline-image");
  const tools = page.getByRole("toolbar", { name: "Image tools" });
  const change = async layout => {
    await image.hover();
    await openImageOptions(page, { custom: true });
    await tools.getByRole("combobox", { name: "Image layout", exact: true }).selectOption(layout);
    await expect(tools.getByRole("combobox", { name: "Image layout", exact: true })).toHaveValue(layout);
    await tools.getByRole("button", { name: "Apply", exact: true }).click();
  };
  await change("center");
  await expect(image).toHaveAttribute("data-image-node", "block");
  await expect(page.locator(".ProseMirror > p")).toHaveText(["Before", "After"]);
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(page.locator("#editor")).toHaveValue(source);
  await change("right");
  await change("inline");
  await expect(image).toHaveAttribute("data-image-node", "inline");
  await expect(page.locator(".ProseMirror")).toHaveText("BeforeAfter");
  await expect(page.locator(".ProseMirror > p")).toHaveCount(1);
  await page.keyboard.press(`${primaryModifier}+s`);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  await expect(page.locator("#editor")).toHaveValue(/display:inline/);
  await chooseView(page, "preview");
  await expect(page.locator("#preview img")).toHaveCSS("display", "inline");
  await chooseView(page, "rich");
  await page.reload();
  await expect(image).toHaveAttribute("data-image-node", "inline");
  await expect(page.locator(".ProseMirror")).toHaveText("BeforeAfter");
});

test("clicking image pixels selects only the block and its following whitespace accepts text", async ({ page, browserName }) => {
  await imageFixture(page, "Image-click-base.md");
  const source = `${blockImage()}\n`;
  await openFixture(page, "Image-click.md", source);
  const image = page.locator(".folio-block-image");
  await image.dblclick();
  await expect(image).toHaveClass(/ProseMirror-selectednode/);
  expect(await page.evaluate(() => document.getSelection().toString())).toBe("");
  await expect(image).toHaveCSS("user-select", "none");
  await capture(page, "image-clean-selection", browserName);
  const bounds = await image.boundingBox();
  await page.mouse.click(bounds.x + bounds.width + 24, bounds.y + bounds.height / 2);
  await expectNativeGap(page);
  await expect(page.locator("#editor")).toHaveValue(source);
  await capture(page, "image-click-after-caret", browserName);
  await page.keyboard.type("Text immediately after the image.");
  await expect(page.locator(".ProseMirror > p")).toHaveText("Text immediately after the image.");
  await expect(page.locator(".folio-block-image")).toHaveCount(1);
});

test("adjacent images can be arranged side by side and keep editable text, preview and narrow layouts", async ({ page, browserName }) => {
  await imageFixture(page, "Image-row-base.md");
  const source = `${blockImage("First")}\n\n${blockImage("Second", "right")}\n\nTail paragraph.\n`;
  await openFixture(page, "Image-row.md", source);
  await openImageOptions(page);
  await page.getByRole("button", { name: "Arrange images side by side", exact: true }).click();
  const row = page.locator(".ProseMirror > .folio-image-row");
  await expect(row.locator(".folio-inline-image")).toHaveCount(2);
  await expect(page.locator(".folio-block-image")).toHaveCount(0);
  const expectRow = async images => {
    const boxes = await images.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON()));
    expect(Math.abs(boxes[0].y - boxes[1].y)).toBeLessThan(2);
    expect(boxes[1].x - boxes[0].x - boxes[0].width).toBeGreaterThanOrEqual(10);
    expect(Math.abs(boxes[0].width - boxes[1].width)).toBeLessThan(2);
    expect(boxes[1].right).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
  };
  await expectRow(row.locator(".folio-inline-image"));
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(page.locator("#editor")).toHaveValue(source);
  await page.keyboard.press(`${primaryModifier}+Shift+z`);
  await expect(row).toBeVisible();
  await page.keyboard.press(`${primaryModifier}+s`);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  await capture(page, "side-by-side-images-desktop", browserName);
  await chooseView(page, "preview");
  const preview = page.locator("#preview .folio-image-row > img");
  await expect(preview).toHaveCount(2);
  await expectRow(preview);
  await chooseView(page, "rich");
  await page.reload();
  await expect(row).toBeVisible();
  await expectRow(row.locator(".folio-inline-image"));
  await page.setViewportSize({ width: 390, height: 844 });
  await expectRow(row.locator(".folio-inline-image"));
  await capture(page, "side-by-side-images-narrow", browserName);
  await page.emulateMedia({ colorScheme: "dark" });
  await capture(page, "side-by-side-images-dark", browserName);
  await row.locator(".folio-inline-image").last().click();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".ProseMirror")).toBeFocused();
  await page.locator(".ProseMirror").evaluate(node => { node.style.caretAnimation = "manual"; });
  await capture(page, "side-by-side-text-caret", browserName);
  await page.keyboard.insertText("Text after the pair.");
  await expect(page.locator(".ProseMirror > p").first()).toHaveText("Text after the pair.");
  await expect(row).toBeVisible();
  await expectRow(row.locator(".folio-inline-image"));
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("Next paragraph.");
  await expect(page.locator(".ProseMirror > p").nth(1)).toHaveText("Next paragraph.");
  await page.keyboard.press(`${primaryModifier}+s`);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  await chooseView(page, "preview");
  await expect(preview).toHaveCount(2);
  await expectRow(preview);
  await expect(page.locator("#preview p").first()).toContainText("Text after the pair.");
});

test("same-line Markdown images stay side by side without rewriting the opened note", async ({ page }) => {
  await imageFixture(page, "Markdown-row-base.md");
  const source = "![First](images/figure.png) ![Second](images/figure.png)\n";
  await openFixture(page, "Markdown-row.md", source);
  const row = page.locator(".ProseMirror > .folio-image-row");
  await expect(row.locator(".folio-inline-image")).toHaveCount(2);
  await expect(page.locator("#editor")).toHaveValue(source);
  await chooseView(page, "preview");
  await expect(page.locator("#preview .folio-image-row > img")).toHaveCount(2);
});

for (const width of [1440, 390]) {
test(`selecting and dismissing adjacent images preserves their spacing and geometry at ${width}px`, async ({ page, browserName }) => {
  await page.setViewportSize({ width, height: 960 });
  await imageFixture(page, "Image-spacing-base.md");
  const picture = (alt, height) => `<img src="images/figure.png" alt="${alt}" style="width:50%;height:${height}px;display:inline">`;
  const source = `${picture("First", 160)}${picture("Second", 280)}\n\nTail paragraph.\n`;
  await openFixture(page, `Image-spacing-${width}.md`, source);
  const row = page.locator(".ProseMirror > .folio-image-row");
  const images = row.locator(".folio-inline-image");
  const writer = page.locator(".ProseMirror > p").last();
  await expect(images).toHaveCount(2);
  await expect.poll(() => images.locator("img").evaluateAll(nodes => nodes.every(node => node.naturalWidth === 640))).toBe(true);
  const geometry = () => row.evaluate(node => {
    const box = element => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    };
    return { row: box(node), images: [...node.querySelectorAll(".folio-inline-image")].map(box),
      children: [...node.childNodes].map(child => ({ name: child.nodeName, classes: child.className ?? "", text: child.nodeValue })),
      html: node.outerHTML };
  });
  await writer.click();
  await page.mouse.move(5, 5);
  const before = await geometry();
  await capture(page, `image-spacing-${width}-before`, browserName);
  const states = [];
  for (const index of [1, 0]) {
    await images.nth(index).click();
    await expect(images.nth(index)).toHaveClass(/ProseMirror-selectednode/);
    await capture(page, `image-spacing-${width}-selected-${index}`, browserName);
    states.push({ name: `selected-${index}`, geometry: await geometry() });
    const short = await images.first().boundingBox();
    await page.mouse.click(short.x + short.width / 2, short.y + short.height + 30);
    await page.mouse.move(5, 5);
    await capture(page, `image-spacing-${width}-row-whitespace-${index}`, browserName);
    states.push({ name: `row-whitespace-${index}`, geometry: await geometry() });
    await writer.click();
    await page.mouse.move(5, 5);
    states.push({ name: `dismissed-${index}`, geometry: await geometry() });
    await capture(page, `image-spacing-${width}-dismissed-${index}`, browserName);
  }
  await images.last().click();
  await page.keyboard.press("ArrowRight");
  await capture(page, `image-spacing-${width}-text-caret`, browserName);
  states.push({ name: "text-caret", geometry: await geometry() });
  await test.info().attach("image-row-spacing", { contentType: "application/json", body: JSON.stringify({ before, states }) });
  const bounds = value => ({ row: value.row, images: value.images });
  for (const state of states) expect(bounds(state.geometry), state.name).toEqual(bounds(before));
  const gap = before.images[1].x - before.images[0].x - before.images[0].width;
  expect(gap).toBeGreaterThanOrEqual(10);
  await expect(page.locator("#editor")).toHaveValue(source);
});
}

test("dragging an image onto another image side creates an undoable image row", async ({ page }) => {
  await imageFixture(page, "Image-side-drop-base.md");
  const source = `${blockImage("First")}\n\n${blockImage("Second")}\n\nTail.\n`;
  await openFixture(page, "Image-side-drop.md", source);
  const images = page.locator(".folio-block-image");
  await expect.poll(() => images.locator("img").evaluateAll(nodes => nodes.every(node => node.naturalWidth === 640))).toBe(true);
  await images.first().click();
  const bounds = await images.last().boundingBox();
  await images.first().dragTo(images.last(), { targetPosition: { x: 4, y: bounds.height / 2 } });
  const rowImages = page.locator(".folio-image-row .folio-inline-image > img");
  await expect(rowImages).toHaveCount(2);
  expect(await rowImages.evaluateAll(nodes => nodes.map(node => node.alt))).toEqual(["First", "Second"]);
  await expect(page.locator(".ProseMirror > p").last()).toHaveText("Tail.");
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(page.locator("#editor")).toHaveValue(source);
});

for (const layout of ["left", "right", "inline"]) {
test(`dragging a resized image into the whitespace beside a ${layout} image creates a row`, async ({ page, browserName }) => {
  await imageFixture(page, "Image-whitespace-drop-base.md");
  const portrait = await page.locator(".folio-inline-image img").evaluate(image => {
    const canvas = document.createElement("canvas");
    canvas.width = 240;
    canvas.height = 400;
    canvas.getContext("2d").drawImage(image, 0, 0, 240, 400);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await fs.writeFile(path.join(root, "images", "portrait.png"), Buffer.from(portrait, "base64"));
  const picture = (alt, width, height, layout) =>
    `<img src="images/${alt === "Dragged" ? "portrait" : "figure"}.png" alt="${alt}" style="width:${width};height:${height}px;`
    + (layout === "inline" ? "display:inline" : `display:block;margin-left:${layout === "left" ? "0" : "auto"};margin-right:${layout === "right" ? "0" : "auto"}`) + '">';
  const source = `${picture("Wide", "100%", 100, "left")}\n\n${picture("Target", "50%", 120, layout)}\n\n`
    + `${picture("Dragged", "25%", 260, layout === "right" ? "left" : "right")}\n\nTail paragraph.\n`;
  await openFixture(page, `Image-whitespace-drop-${layout}.md`, source);
  const target = page.locator(".folio-inline-image").filter({ has: page.locator('img[alt="Target"]') });
  const dragged = page.locator(".folio-inline-image").filter({ has: page.locator('img[alt="Dragged"]') });
  await expect.poll(() => dragged.locator("img").evaluate(node => node.naturalWidth)).toBe(240);
  await dragged.click();
  const bounds = await dragged.boundingBox();
  const destination = await target.boundingBox();
  const x = layout === "right" ? destination.x - 70 : destination.x + destination.width + 70;
  const y = destination.y + destination.height / 2;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 10, bounds.y + bounds.height / 2 - 10, { steps: 4 });
  await page.mouse.move(x, y, { steps: 16 });
  await capture(page, `image-whitespace-${layout}-dragging`, browserName);
  await expect(target).toHaveAttribute("data-image-drop", layout === "right" ? "before" : "after");
  await expect(page.locator(".prosemirror-dropcursor-block")).toBeHidden();
  await page.mouse.up();
  const row = page.locator(".ProseMirror > .folio-image-row");
  await expect(row.locator(".folio-inline-image")).toHaveCount(2);
  expect(await row.locator(".folio-inline-image > img").evaluateAll(nodes => nodes.map(node => node.alt)))
    .toEqual(layout === "right" ? ["Dragged", "Target"] : ["Target", "Dragged"]);
  const boxes = await row.locator(".folio-inline-image").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON()));
  expect(Math.abs(boxes[0].y - boxes[1].y)).toBeLessThan(2);
  expect(boxes[1].x - boxes[0].right).toBeGreaterThanOrEqual(10);
  await expect(page.locator("[data-image-drop], .ProseMirror[data-image-row-drop]")).toHaveCount(0);
  await expect(page.locator(".ProseMirror > p").last()).toHaveText("Tail paragraph.");
  await capture(page, `image-whitespace-${layout}-dropped`, browserName);
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(page.locator("#editor")).toHaveValue(source);
  if (layout !== "left") return;
  await page.keyboard.press(`${primaryModifier}+Shift+z`);
  await page.keyboard.press(`${primaryModifier}+s`);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  await chooseView(page, "preview");
  await expect(page.locator("#preview .folio-image-row > img")).toHaveCount(2);
  await capture(page, "image-whitespace-preview", browserName);
  await chooseView(page, "rich");
  await page.reload();
  await expect(row.locator(".folio-inline-image")).toHaveCount(2);
  await page.setViewportSize({ width: 390, height: 844 });
  const narrow = await row.locator(".folio-inline-image").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON()));
  expect(Math.abs(narrow[0].y - narrow[1].y)).toBeLessThan(2);
  expect(narrow[1].right).toBeLessThanOrEqual(390);
  await capture(page, "image-whitespace-narrow", browserName);
});
}

test("directly dragging into an existing inline image row inserts and reorders images without duplication", async ({ page, browserName }) => {
  await imageFixture(page, "Image-existing-row-base.md");
  const inline = alt => `<img src="images/figure.png" alt="${alt}" style="width:50%;display:inline">`;
  const source = `${inline("First")}${inline("Second")}\n\n${blockImage("Third", "right")}\n\nTail.\n`;
  await openFixture(page, "Image-existing-row.md", source);
  const row = page.locator(".ProseMirror > .folio-image-row");
  const first = row.locator(".folio-inline-image").first();
  const third = page.locator(".folio-block-image");
  await expect.poll(() => third.locator("img").evaluate(node => node.naturalWidth)).toBe(640);
  let bounds = await first.boundingBox();
  await third.dragTo(first, { targetPosition: { x: bounds.width - 4, y: bounds.height / 2 } });
  await expect(row.locator(".folio-inline-image")).toHaveCount(3);
  const order = () => row.locator(".folio-inline-image > img").evaluateAll(nodes => nodes.map(node => node.alt));
  expect(await order()).toEqual(["First", "Third", "Second"]);
  bounds = await first.boundingBox();
  await row.locator(".folio-inline-image").last().dragTo(first, { targetPosition: { x: 4, y: bounds.height / 2 } });
  expect(await order()).toEqual(["Second", "First", "Third"]);
  await capture(page, "image-existing-row-reordered", browserName);
  await page.keyboard.press(`${primaryModifier}+z`);
  expect(await order()).toEqual(["First", "Third", "Second"]);
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(page.locator("#editor")).toHaveValue(source);
});

test("dragging an image after another aligned image changes their persisted order without empty wrappers", async ({ page }) => {
  await imageFixture(page, "Image-reorder-base.md");
  const source = `${blockImage("First")}\n\n${blockImage("Second")}\n\nTail.\n`;
  await openFixture(page, "Image-reorder.md", source);
  const images = page.locator(".folio-block-image");
  await expect(images).toHaveCount(2);
  await expect.poll(() => images.locator("img").evaluateAll(nodes => nodes.every(node => node.naturalWidth === 640))).toBe(true);
  await images.first().click();
  const bounds = await images.last().boundingBox();
  await images.first().dragTo(images.last(), { targetPosition: { x: bounds.width - 4, y: bounds.height - 4 } });
  await expect.poll(async () => {
    const text = await page.locator("#editor").inputValue();
    return text.indexOf('alt="Second"') < text.indexOf('alt="First"');
  }).toBe(true);
  await expect(images).toHaveCount(2);
  await expect(page.locator(".ProseMirror > p")).toHaveText("Tail.");
  await page.keyboard.press(`${primaryModifier}+s`);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  const saved = await fs.readFile(path.join(root, "Image-reorder.md"), "utf8");
  expect(saved.indexOf('alt="Second"')).toBeLessThan(saved.indexOf('alt="First"'));
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(page.locator("#editor")).toHaveValue(source);
});

for (const after of [false, true]) {
test(`dropping a new image ${after ? "after" : "before"} an existing block preserves both images and surrounding paragraphs`, async ({ page }) => {
  const original = await imageFixture(page, "Image-file-drop-base.md");
  const source = `Before.\n\n${blockImage()}\n\nAfter.\n`;
  await openFixture(page, after ? "Image-file-drop-after.md" : "Image-file-drop-before.md", source);
  const transfer = await page.evaluateHandle(bytes => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], "dropped.png", { type: "image/png" }));
    return transfer;
  }, [...original]);
  const image = page.locator(".folio-block-image");
  const bounds = await image.boundingBox();
  await image.dispatchEvent("drop", {
    dataTransfer: transfer, clientX: bounds.x + bounds.width / 2, clientY: bounds.y + bounds.height * (after ? 0.8 : 0.2),
  });
  await expect(page.locator(".folio-block-image")).toHaveCount(2);
  await expect(page.locator(".ProseMirror > p")).toHaveText(["Before.", "After."]);
  await expect.poll(() => page.locator(".folio-block-image img").evaluateAll(nodes => nodes.map(node => node.alt)))
    .toEqual(after ? ["Figure", "Image"] : ["Image", "Figure"]);
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(page.locator("#editor")).toHaveValue(source);
});
}

for (const [kind, source] of [
  ["Markdown", '![Figure](images/figure.png "Original")\n'],
  ["reference", '![Figure][figure]\n\n[figure]: images/figure.png "Original"\n'],
  ["list", '- ![Figure](images/figure.png "Original")\n'],
  ["ordered-list", '3. ![Figure](images/figure.png "Original")\n'],
  ["task-list", '- [ ] ![Figure](images/figure.png "Original")\n'],
  ["quote", '> ![Figure](images/figure.png "Original")\n'],
]) {
test(`standalone ${kind} images use native blocks without rewriting the source on open`, async ({ page, browserName }) => {
  await imageFixture(page, "Image-existing-base.md");
  const name = `Image-existing-${kind}.md`;
  await openFixture(page, name, source);
  await expect(page.locator(".folio-block-image")).toHaveCount(1);
  await expect(page.locator("#editor")).toHaveValue(source);
  expect(await fs.readFile(path.join(root, name), "utf8")).toBe(source);
  if (["list", "ordered-list", "task-list"].includes(kind)) {
    await expect(page.locator(".ProseMirror li > div > p")).toHaveCount(0);
    const item = await page.locator(".ProseMirror li").boundingBox();
    const picture = await page.locator(".folio-block-image").boundingBox();
    expect(Math.abs(picture.y - item.y)).toBeLessThanOrEqual(2);
    if (kind === "ordered-list") await expect(page.locator(".ProseMirror ol")).toHaveAttribute("start", "3");
    await page.locator(".folio-block-image").click();
    await page.keyboard.press("Enter");
    await page.keyboard.insertText("Text after the image.");
    await expect(page.locator(".ProseMirror li p").last()).toHaveText("Text after the image.");
    if (kind === "task-list") await page.locator(".folio-task-checkbox").check();
    await page.keyboard.press(`${primaryModifier}+s`);
    await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    await page.reload();
    await expect(page.locator(".folio-block-image")).toHaveCount(1);
    await expect(page.locator(".ProseMirror li p").last()).toHaveText("Text after the image.");
    if (kind === "task-list") await expect(page.locator(".folio-task-checkbox")).toBeChecked();
    if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath(`${kind}-image-text.png`), caret: "initial" });
  }
});
}

test("an editable line before a leading list image never saves the image outside its list", async ({ page }) => {
  await imageFixture(page, "List-before-base.md");
  await openFixture(page, "List-before.md", '- ![Figure](images/figure.png "Original")\n');
  await page.locator(".folio-block-image").click();
  await page.keyboard.press("ArrowLeft");
  await expectNativeGap(page);
  await page.keyboard.press("Enter");
  await expect(page.locator(".ProseMirror li p")).toHaveCount(1);
  await page.keyboard.press(`${primaryModifier}+s`);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  await page.reload();
  await expect(page.locator(".ProseMirror li .folio-block-image")).toHaveCount(1);
  await expect(page.locator(".ProseMirror > .folio-block-image")).toHaveCount(0);
});

test("moving an image out of a list removes the vacated item and remains undoable", async ({ page }) => {
  await imageFixture(page, "List-move-base.md");
  const source = '- ![Listed](images/figure.png)\n- Kept item.\n\n![Target](images/figure.png)\n';
  await openFixture(page, "List-move.md", source);
  const listed = page.locator(".ProseMirror li .folio-block-image");
  const target = page.locator(".ProseMirror > .folio-block-image");
  await listed.click();
  const bounds = await target.boundingBox();
  await listed.dragTo(target, { targetPosition: { x: bounds.width - 4, y: bounds.height - 4 } });
  await expect(page.locator(".ProseMirror li")).toHaveCount(1);
  await expect(page.locator(".ProseMirror li")).toHaveText("Kept item.");
  await expect(page.locator(".ProseMirror > .folio-block-image")).toHaveCount(2);
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(page.locator("#editor")).toHaveValue(source);
});
