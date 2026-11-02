import { test, expect, fs, path, root, openFixture, chooseView, primaryModifier, userDocumentUrl, openImageOptions, openTableTools, openLinkOptions } from "./fixture.mjs";
import { collaborativeLibrary } from "./collaboration-cases.mjs";

export async function imageFixture(page, name) {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 320;
    const context = canvas.getContext("2d");
    context.fillStyle = "#e7edf3";
    context.fillRect(0, 0, 640, 320);
    for (const [index, height] of [110, 180, 145, 230, 200].entries()) {
      context.fillStyle = ["#627d98", "#8ba4b9", "#a9bdca", "#7895ac", "#526f89"][index];
      context.fillRect(65 + index * 105, 280 - height, 65, height);
    }
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const image = Buffer.from(base64, "base64");
  await fs.writeFile(path.join(root, "images", "figure.png"), image);
  await openFixture(page, name, '![Figure](images/figure.png "Original")\n\nTail paragraph.\n');
  await expect.poll(() => page.locator(".folio-inline-image img").evaluate(image => image.naturalWidth)).toBe(640);
  return image;
}

async function imageTools(page) {
  await page.locator(".folio-inline-image").hover();
  const tools = page.getByRole("toolbar", { name: "Image tools" });
  await expect(tools).toBeVisible();
  return tools;
}

async function imageReplacement(page) {
  const tools = await imageTools(page);
  await tools.getByRole("button", { name: "Image actions", exact: true }).click();
  return tools.getByRole("menuitem", { name: "Replace image", exact: true });
}

test("escaping slash commands keeps the slash and all typed command text", async ({ page }) => {
  await openFixture(page, "Slash-text.md", "");
  const editor = page.locator(".ProseMirror");
  await editor.focus();
  await editor.pressSequentially("/h2");
  await expect(editor).toHaveText("/h2");
  await expect(page.locator("#folio-slash-menu")).toBeVisible();
  await editor.press("Escape");
  await editor.pressSequentially(" remains text");
  await expect(page.locator("#folio-slash-menu")).toBeHidden();
  await expect(editor).toHaveText("/h2 remains text");
  await expect(page.locator("#editor")).toHaveValue(/^\/h2 remains text\n?$/);
});

test("image size and layout round-trip through safe HTML, preview, reload and undo", async ({ page, browserName }) => {
  await imageFixture(page, "Image-layout.md");
  const tools = await imageTools(page);
  await openImageOptions(page, { custom: true });
  await tools.getByRole("textbox", { name: "Image width", exact: true }).fill("50%");
  await tools.getByRole("combobox", { name: "Image layout", exact: true }).selectOption("center");
  await tools.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.locator("#document-panes")).toHaveAttribute("data-view", "rich");
  await expect(page.locator("#editor")).toHaveValue(/<img .*style="width:50%;display:block;margin-left:auto;margin-right:auto"/);
  const image = page.locator(".folio-inline-image");
  await expect(image).toHaveAttribute("data-layout", "center");
  const paragraph = page.locator(".ProseMirror > p").first();
  await expect.poll(async () => (await image.boundingBox()).width / (await paragraph.boundingBox()).width).toBeCloseTo(0.5, 1);
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(page.locator("#editor")).toHaveValue('![Figure](images/figure.png "Original")\n\nTail paragraph.\n');
  await page.keyboard.press(`${primaryModifier}+Shift+z`);
  await expect(page.locator("#editor")).toHaveValue(/width:50%/);
  await page.keyboard.press(`${primaryModifier}+s`);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  const saved = await fs.readFile(path.join(root, "Image-layout.md"), "utf8");
  expect(saved).toContain('src="images/figure.png"');
  await chooseView(page, "preview");
  const preview = page.locator("#preview img");
  await expect(preview).toHaveAttribute("src", /\/assets\?id=/);
  await expect.poll(() => preview.evaluate(image => image.naturalWidth)).toBe(640);
  await chooseView(page, "rich");
  await page.reload();
  await expect(page.locator(".folio-inline-image")).toHaveAttribute("data-layout", "center");
  await expect(page.locator("#editor")).toHaveValue(saved);
  await openImageOptions(page, { custom: true });
  if (browserName !== "webkit") {
    await page.screenshot({ path: test.info().outputPath("image-tools-desktop.png"), caret: "initial" });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: test.info().outputPath("image-tools-dark.png"), caret: "initial" });
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 390, height: 844 });
    await openImageOptions(page, { custom: true });
    await page.screenshot({ path: test.info().outputPath("image-tools-narrow.png"), caret: "initial" });
  }
});

test("image hover supports native saving, replacement during typing and safe navigation", async ({ page }) => {
  const original = await imageFixture(page, "Image-replace.md");
  const tools = await imageTools(page);
  const downloading = page.waitForEvent("download");
  await tools.getByRole("button", { name: "Save image as", exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("figure.png");
  expect(await fs.readFile(await download.path())).toEqual(original);
  let release;
  let uploaded;
  const submitted = new Promise(resolve => { uploaded = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  await page.route("**/api/images?**", async route => {
    uploaded();
    await held;
    await route.continue();
  });
  try {
    const before = await page.locator(".folio-inline-image img").getAttribute("src");
    const choosing = page.waitForEvent("filechooser");
    await (await imageReplacement(page)).click();
    await (await choosing).setFiles({ name: "replacement.png", mimeType: "image/png", buffer: original });
    await submitted;
    await page.locator(".ProseMirror p").last().click();
    await page.keyboard.press("End");
    await page.keyboard.insertText(" Kept during upload.");
    release();
    await expect(page.locator(".folio-inline-image img")).not.toHaveAttribute("src", before);
    await expect(page.locator(".ProseMirror")).toContainText("Tail paragraph. Kept during upload.");
    await expect(page.locator(".ProseMirror")).toBeFocused();
    await page.keyboard.insertText(" Still writing.");
    await expect(page.locator(".ProseMirror p").last()).toHaveText("Tail paragraph. Kept during upload. Still writing.");
    await expect(page.locator(".folio-inline-image img")).toHaveAttribute("alt", "Figure");
    await expect(page.locator(".folio-inline-image img")).toHaveAttribute("title", "Original");
    await expect(page.locator("#document-panes")).toHaveAttribute("data-view", "rich");
    await page.keyboard.press(`${primaryModifier}+s`);
    await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    await expect(page.locator("#editor")).toHaveValue(/!\[Figure\]\(assets\/images\/.*"Original"\)/);
  } finally { release(); }
  await page.unroute("**/api/images?**");
  const saved = await fs.readFile(path.join(root, "Image-replace.md"), "utf8");
  let finish;
  let arrived;
  const pending = new Promise(resolve => { finish = resolve; });
  const begun = new Promise(resolve => { arrived = resolve; });
  await page.route("**/api/images?**", async route => {
    arrived();
    await pending;
    await route.continue();
  });
  try {
    const choosing = page.waitForEvent("filechooser");
    await (await imageReplacement(page)).click();
    await (await choosing).setFiles({ name: "not-another-note.png", mimeType: "image/png", buffer: original });
    await begun;
    await page.locator('[data-path="Second.md"]').click();
    await expect(page.locator("#document-title")).toHaveText("Second.md");
    finish();
    await expect(page.locator("#image-message")).toContainText(/changed while uploading/);
    await expect(page.locator(".folio-inline-image")).toHaveCount(0);
    expect(await fs.readFile(path.join(root, "Image-replace.md"), "utf8")).toBe(saved);
    expect(await fs.readFile(path.join(root, "Second.md"), "utf8")).toBe("# Second\n\nAnother note.\n");
  } finally { finish(); }
});

test("image drag resizing commits one undoable change and retains Live mode", async ({ page }) => {
  await imageFixture(page, "Image-drag.md");
  const image = page.locator(".folio-inline-image");
  await image.hover();
  await image.click();
  const handle = image.getByRole("button", { name: "Resize image", exact: true });
  const bounds = await handle.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x - 110, bounds.y + 20, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator("#editor")).toHaveValue(/<img .*style="width:\d+px(?:;|")/);
  await expect(page.locator("#document-panes")).toHaveAttribute("data-view", "rich");
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(page.locator("#editor")).toHaveValue('![Figure](images/figure.png "Original")\n\nTail paragraph.\n');
});

test("image hover exposes compact common actions and selecting reveals the resize frame", async ({ page, browserName }) => {
  await imageFixture(page, "Image-corner.md");
  const image = page.locator(".folio-inline-image");
  await image.hover();
  const toolbar = page.getByRole("toolbar", { name: "Image tools" });
  await expect(toolbar).toBeVisible();
  await expect(toolbar.getByRole("button")).toHaveCount(4);
  for (const name of ["Image size and layout", "Preview image", "Save image as", "Image actions"]) {
    await expect(toolbar.getByRole("button", { name, exact: true })).toBeVisible();
  }
  await expect(toolbar.getByRole("menuitem")).toHaveCount(0);
  await expect(image.getByRole("button", { name: "Resize image", exact: true })).toBeVisible();
  await expect(image.getByRole("button", { name: "Resize image from left", exact: true })).toBeVisible();
  const bounds = await image.boundingBox();
  const menu = await toolbar.boundingBox();
  expect(menu.x + menu.width).toBeLessThanOrEqual(bounds.x + bounds.width);
  expect(menu.x + menu.width).toBeGreaterThan(bounds.x + bounds.width - 12);
  expect(menu.height).toBeLessThanOrEqual(32);
  expect(menu.y).toBeGreaterThanOrEqual(bounds.y);
  expect(menu.y).toBeLessThan(bounds.y + 20);
  if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath("image-corner-hover.png"), caret: "initial" });
  await image.click();
  await expect(image).toHaveClass(/ProseMirror-selectednode/);
  expect(await image.evaluate(node => getComputedStyle(node).outlineStyle)).toBe("solid");
  await expect(image.getByRole("button", { name: "Resize image", exact: true })).toBeVisible();
  if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath("image-selected-frame.png"), caret: "initial" });
});

test("dragging a selected image rearranges the document without uploading or duplicating it", async ({ page }) => {
  await imageFixture(page, "Image-move-base.md");
  const source = 'Before.\n\n![Figure](images/figure.png "Original")\n\nAfter.\n\nDrop target.\n';
  await openFixture(page, "Image-move.md", source);
  const image = page.locator(".folio-inline-image");
  const target = page.locator(".ProseMirror p").filter({ hasText: /^Drop target\.$/ });
  let uploads = 0;
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/images") uploads++;
  });
  await image.click();
  const bounds = await target.boundingBox();
  await image.dragTo(target, { targetPosition: { x: bounds.width - 5, y: bounds.height / 2 } });
  await expect.poll(async () => {
    const text = await page.locator("#editor").inputValue();
    return text.indexOf("Drop target.") < text.indexOf("![Figure]");
  }).toBe(true);
  await expect(page.locator(".folio-inline-image")).toHaveCount(1);
  expect(uploads).toBe(0);
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(page.locator("#editor")).toHaveValue(source);
});
test("a pending image replacement cannot modify Source after leaving Live", async ({ page }) => {
  const original = await imageFixture(page, "Image-view-change.md");
  let release;
  let started;
  const begun = new Promise(resolve => { started = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  await page.route("**/api/images?**", async route => {
    started();
    await pending;
    await route.continue();
  });
  try {
    const choosing = page.waitForEvent("filechooser");
    await (await imageReplacement(page)).click();
    await (await choosing).setFiles({ name: "not-source.png", mimeType: "image/png", buffer: original });
    await begun;
    await chooseView(page, "editor");
    const source = '![Figure](images/figure.png "Original")\n\nSource text is kept.\n';
    await page.locator("#editor").fill(source);
    release();
    await expect(page.locator("#image-message")).toContainText("image changed while uploading");
    await expect(page.locator("#editor")).toHaveValue(source);
    await expect(page.getByRole("toolbar", { name: "Image tools" })).toBeHidden();
  } finally { release(); }
});

test("styled inline images preserve adjacent Markdown and literal image code", async ({ page }) => {
  await imageFixture(page, "Mixed-base.md");
  const source = '<img src="images/figure.png" alt="First" style="width:35%"> and **bold** ![Second](images/pixel.png) `<img src="literal.png">`.\n';
  await openFixture(page, "Mixed-image.md", source);
  await expect(page.locator(".folio-inline-image img")).toHaveCount(2);
  await expect(page.locator(".ProseMirror strong")).toHaveText("bold");
  await expect(page.locator(".ProseMirror code")).toHaveText('<img src="literal.png">');
  await expect(page.locator("#editor")).toHaveValue(source);
  await chooseView(page, "preview");
  await expect(page.locator("#preview img")).toHaveCount(2);
  await expect(page.locator("#preview strong")).toHaveText("bold");
  await expect(page.locator("#preview code")).toHaveText('<img src="literal.png">');
  await chooseView(page, "rich");
  await page.reload();
  await expect(page.locator(".folio-inline-image img")).toHaveCount(2);
  await expect(page.locator("#editor")).toHaveValue(source);
});

test("read-only image and table tools allow exports but never enable image changes", async ({ browser }) => {
  const content = "![Figure](figure.png)\n\n| Name | Value |\n| --- | --- |\n| Folio | Read only |\n\n"
    + "```rust\nfn main() {}\n```\n\n> Quote **kept**.\n\n[Guide](https://example.com)\n";
  const library = await collaborativeLibrary(browser, { content, participants: 1, sharing: "read" });
  const context = await browser.newContext();
  try {
    await fs.copyFile(path.join(root, "images/pixel.png"), path.join(library.notes, "figure.png"));
    const login = await context.request.post(new URL("/api/auth/login", library.url).href, {
      data: { username: "bob", password: "bob test password long enough" },
    });
    expect(login.ok()).toBe(true);
    const page = await context.newPage();
    await page.goto(await userDocumentUrl(context, library.url, "Shared.md"));
    await expect(page.locator(".ProseMirror")).toHaveAttribute("contenteditable", "false");
    const tools = await imageTools(page);
    await expect(tools.getByRole("button", { name: "Save image as", exact: true })).toBeEnabled();
    await tools.getByRole("button", { name: "Image actions", exact: true }).click();
    await expect(tools.getByRole("menuitem", { name: "Copy image Markdown", exact: true })).toBeEnabled();
    await expect(tools.getByRole("menuitem", { name: "Replace image", exact: true })).toBeDisabled();
    await expect(tools.getByRole("button", { name: "Image size and layout", exact: true })).toBeDisabled();
    await expect(tools.getByRole("menuitem", { name: "Remove image", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Resize image", exact: true })).toBeHidden();
    for (const selector of [".folio-code-block", ".folio-block-image", ".ProseMirror blockquote"]) {
      await page.locator(selector).hover();
      await page.locator(".folio-block-grip").click();
      const menu = page.getByRole("menu", { name: "Block actions", exact: true });
      await expect(menu.getByRole("menuitem", { name: "Duplicate block", exact: true })).toBeDisabled();
      await expect(menu.getByRole("menuitem", { name: "Delete block", exact: true })).toBeDisabled();
      await expect(menu).toBeFocused();
      await expect(menu.getByText(/Copy .*as/)).toHaveCount(0);
      await menu.press("Escape");
    }
    const axisMenu = await openTableTools(page);
    await expect(axisMenu.locator(".folio-table-export")).toBeHidden();
    await expect(axisMenu).toBeFocused();
    await openTableTools(page, 0, "table");
    await expect(page.getByRole("menu", { name: "Table actions", exact: true })).toBeVisible();
    await page.locator(".folio-table-export > summary").click();
    await expect(page.getByRole("button", { name: "Copy table as CSV", exact: true })).toBeEnabled();
    await expect(page.getByRole("menuitemradio", { name: "Align left", exact: true })).toBeDisabled();
    await page.getByRole("menu", { name: "Table actions", exact: true }).press("Escape");
    await page.keyboard.press("Escape");
    await expect(page.locator(".folio-table-selection")).toBeHidden();
    const linkOptions = await openLinkOptions(page);
    await expect(linkOptions.getByRole("button", { name: "Apply", exact: true })).toHaveCount(0);
    await expect(linkOptions.getByRole("textbox", { name: "Link target" })).toHaveAttribute("readonly", "");
    expect(await fs.readFile(path.join(library.notes, "Shared.md"), "utf8")).toBe(content);
  } finally { await context.close(); await library.close(); }
});

test("image layout changes merge collaboratively without rebuilding the remote Live editor", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { content: "![Figure](figure.png)\n\nTail paragraph.\n" });
  try {
    await fs.copyFile(path.join(root, "images/pixel.png"), path.join(library.notes, "figure.png"));
    await Promise.all(library.pages.map(page => page.reload()));
    const [owner, peer] = library.pages;
    for (const page of library.pages) await expect(page.locator("#collaboration-join")).toHaveAttribute("aria-pressed", "true");
    const remote = await peer.locator(".ProseMirror").elementHandle();
    const tools = await imageTools(owner);
    await openImageOptions(owner, { custom: true });
    await tools.getByRole("textbox", { name: "Image width", exact: true }).fill("40%");
    await tools.getByRole("combobox", { name: "Image layout", exact: true }).selectOption("right");
    await peer.evaluate(() => {
      const source = document.getElementById("editor");
      source.value = source.value.replace("Tail paragraph.", "Tail paragraph. Peer text is kept.");
      source.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await expect(owner.locator(".ProseMirror")).toContainText("Peer text is kept.");
    await expect(tools.getByRole("textbox", { name: "Image width", exact: true })).toHaveValue("40%");
    await expect(tools.getByRole("combobox", { name: "Image layout", exact: true })).toHaveValue("right");
    await tools.getByRole("button", { name: "Apply", exact: true }).click();
    for (const page of library.pages) {
      await expect(page.locator(".folio-inline-image")).toHaveAttribute("data-layout", "right");
      await expect(page.locator("#editor")).toHaveValue(/width:40%/);
      await expect(page.locator("#document-panes")).toHaveAttribute("data-view", "rich");
    }
    expect(await remote.evaluate(node => node.isConnected && node === document.querySelector(".ProseMirror"))).toBe(true);
    await owner.keyboard.press(`${primaryModifier}+s`);
    await expect(owner.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    expect(await fs.readFile(path.join(library.notes, "Shared.md"), "utf8")).toContain("width:40%");
  } finally { await library.close(); }
});

test("table hover copies only the current table as Markdown, HTML, CSV, TSV and JSON", async ({ page, browserName }) => {
  const source = '| **Name** | Value |\n| :--- | ---: |\n| A & B | One, "two" |\n| Pipe \\| value | Line |\n\nTail.\n\n| Second |\n| --- |\n| Other |\n';
  await openFixture(page, "Table-tools.md", source);
  await page.evaluate(() => {
    window.folioTableCopies = [];
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true, value: async value => { window.folioTableCopies.push(value); },
    });
  });
  const tools = await openTableTools(page, 0, "table");
  await tools.locator(".folio-table-export > summary").click();
  for (const name of ["Markdown", "HTML", "CSV", "TSV", "JSON"]) {
    await tools.getByRole("button", { name: `Copy table as ${name}`, exact: true }).click();
  }
  const values = await page.evaluate(() => window.folioTableCopies);
  expect(values).toHaveLength(5);
  expect(values[0]).toContain("**Name**");
  expect(values[0]).not.toContain("Second");
  expect(values[1]).toContain("<table>");
  expect(values[1]).toContain("A &amp; B");
  expect(values[2]).toBe('Name,Value\r\nA & B,"One, ""two"""\r\nPipe | value,Line\r\n');
  expect(values[3]).toBe('Name\tValue\nA & B\t"One, ""two"""\nPipe | value\tLine\n');
  expect(JSON.parse(values[4])).toEqual([["Name", "Value"], ["A & B", 'One, "two"'], ["Pipe | value", "Line"]]);
  await expect(page.locator("#editor")).toHaveValue(source);
  expect(await fs.readFile(path.join(root, "Table-tools.md"), "utf8")).toBe(source);
  if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath("table-tools-desktop.png"), caret: "initial" });
  await openTableTools(page, 1, "table");
  if (await tools.locator(".folio-table-export").getAttribute("open") === null) await tools.locator(".folio-table-export > summary").click();
  await tools.getByRole("button", { name: "Copy table as JSON", exact: true }).click();
  expect(JSON.parse(await page.evaluate(() => window.folioTableCopies.at(-1)))).toEqual([["Second"], ["Other"]]);
});

test("table edge controls extend rows and columns without opening tools and preserve undo", async ({ page, browserName }) => {
  const source = "| Name | State |\n| --- | --- |\n| First | Draft |\n| Second | Ready |\n\nTail.\n";
  await openFixture(page, "Table-edges.md", source);
  const table = page.locator(".folio-table-wrapper");
  const tools = page.getByRole("menu", { name: "Table actions", exact: true });
  await table.locator("td").last().click();
  await page.mouse.move(5, 5);
  await expect(table.locator(".folio-table-add-row")).toHaveCSS("opacity", "0");
  await expect(table.locator(".folio-table-add-column")).toHaveCSS("opacity", "0");
  await expect(table.locator(".folio-table-column-grip")).toHaveCSS("opacity", "1");
  if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath("table-add-controls-hidden.png") });
  await table.locator(".folio-table-add-region-row").hover();
  await expect(table.locator(".folio-table-add-row")).toHaveCSS("opacity", "1");
  await expect(table.locator(".folio-table-add-column")).toHaveCSS("opacity", "0");
  if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath("table-add-controls-hover.png") });
  const rowControl = await table.locator(".folio-table-add-row").boundingBox();
  await page.mouse.move(rowControl.x + rowControl.width / 2, rowControl.y + rowControl.height / 2, { steps: 12 });
  await expect(table.locator(".folio-table-add-row")).toHaveCSS("opacity", "1");
  await table.getByRole("button", { name: "Add row at end", exact: true }).click();
  await expect(table.locator("tr")).toHaveCount(4);
  await expect(tools).toBeHidden();
  await table.locator(".folio-table-add-region-column").hover();
  await table.getByRole("button", { name: "Add column at end", exact: true }).click();
  await expect(table.locator("th")).toHaveCount(3);
  await expect(tools).toBeHidden();
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(table.locator("th")).toHaveCount(2);
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(page.locator("#editor")).toHaveValue(source);
  if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath("table-quiet-desktop.png"), caret: "initial" });
  await page.setViewportSize({ width: 390, height: 844 });
  await table.locator("td").last().click();
  await expect(tools).toBeHidden();
  if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath("table-quiet-narrow.png"), caret: "initial" });
  for (let column = 2; column < 6; column++) {
    await table.locator(".folio-table-add-region-column").hover();
    await table.getByRole("button", { name: "Add column at end", exact: true }).click();
  }
  await expect(table.locator("th")).toHaveCount(6);
  expect(await table.locator(".folio-table-scroll").evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(tools).toBeHidden();
  if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath("table-wide-columns-narrow.png"), caret: "initial" });
});

test("table cells stay neutral on hover and handle menus duplicate and clear only their selected axis without search", async ({ page, browserName }) => {
  const source = "| Name | State | Owner |\n| --- | --- | --- |\n| A | Draft | One |\n| B | Ready | Two |\n\nTail paragraph.\n";
  await openFixture(page, "Table-contextual.md", source);
  const table = page.locator(".folio-table-wrapper");
  const menu = page.getByRole("menu", { name: "Table actions", exact: true });
  const cell = table.locator("td").nth(1);
  await page.locator(".ProseMirror > p").last().click();
  const before = await cell.evaluate(node => ({ cell: getComputedStyle(node).backgroundColor, row: getComputedStyle(node.parentElement).backgroundColor }));
  await cell.hover();
  expect(await cell.evaluate(node => ({ cell: getComputedStyle(node).backgroundColor, row: getComputedStyle(node.parentElement).backgroundColor }))).toEqual(before);
  await expect(page.locator(".folio-table-open")).toHaveCount(0);
  await expect(menu).toBeHidden();
  await cell.click();
  await expect(table.locator(".folio-table-selection")).toBeVisible();
  const grip = table.locator(".folio-table-column-grip");
  await grip.hover();
  expect(await grip.evaluate(node => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d");
    context.fillStyle = getComputedStyle(node).backgroundColor;
    context.fillRect(0, 0, 1, 1);
    return context.getImageData(0, 0, 1, 1).data[3];
  })).toBe(255);
  const selected = await cell.boundingBox();
  const frame = await table.locator(".folio-table-selection").boundingBox();
  expect(Math.abs(frame.x - selected.x)).toBeLessThan(1);
  expect(Math.abs(frame.y - selected.y)).toBeLessThan(1);
  expect(Math.abs(frame.width - selected.width)).toBeLessThan(1);
  expect(Math.abs(frame.height - selected.height)).toBeLessThan(1);
  if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath("notion-table-active-cell.png") });
  const viewport = await page.locator(".folio-live-scroll").boundingBox();
  await openTableTools(page);
  await expect(menu.getByRole("searchbox")).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: "Insert left", exact: true })).toBeFocused();
  await menu.getByRole("menuitem", { name: "Insert left", exact: true }).press("ArrowUp");
  await expect(menu.getByRole("menuitemradio", { name: "Align right", exact: true })).toBeFocused();
  await menu.getByRole("menuitemradio", { name: "Align right", exact: true }).press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "Insert left", exact: true })).toBeFocused();
  expect(await page.locator(".folio-live-scroll").boundingBox()).toEqual(viewport);
  if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath("notion-table-column-menu.png") });
  await expect(menu.getByRole("menuitem")).toHaveCount(5);
  await menu.getByRole("menuitem", { name: "Duplicate column", exact: true }).click();
  await expect(table.locator("th")).toHaveCount(4);
  await expect(table.locator("tr").nth(1).locator("td")).toHaveText(["A", "Draft", "Draft", "One"]);
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(page.locator("#editor")).toHaveValue(source);
  await cell.click();
  await openTableTools(page, 0, "row");
  await menu.getByRole("menuitem", { name: "Duplicate row", exact: true }).click();
  await expect(table.locator("tr")).toHaveCount(4);
  await page.keyboard.press(`${primaryModifier}+z`);
  await cell.click();
  await openTableTools(page, 0, "row");
  await menu.getByRole("menuitem", { name: "Clear contents", exact: true }).click();
  await expect(table.locator("tr").nth(1).locator("td")).toHaveText(["", "", ""]);
  await expect(table.locator("tr").last().locator("td")).toHaveText(["B", "Ready", "Two"]);
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(page.locator("#editor")).toHaveValue(source);
  await page.setViewportSize({ width: 390, height: 844 });
  await cell.click();
  await openTableTools(page);
  const bounds = await menu.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(8);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(382);
  if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath("notion-table-menu-narrow.png") });
  await menu.press("Escape");
  await expect(page.locator(".ProseMirror")).toBeFocused();
  await page.keyboard.insertText(" kept");
  await expect(table.locator("tr").nth(1).locator("td")).toHaveText(["A", /kept/, "One"]);
});

test("image tools preview local images and expose two side grips without changing layout", async ({ page, browserName }) => {
  await imageFixture(page, "Image-contextual.md");
  const image = page.locator(".folio-inline-image");
  await image.click();
  const bounds = await image.boundingBox();
  for (const name of ["Resize image", "Resize image from left"]) {
    const handle = image.getByRole("button", { name, exact: true });
    await expect(handle).toBeVisible();
    const grip = await handle.boundingBox();
    expect(grip.height).toBeGreaterThan(grip.width * 3);
    expect(Math.abs(grip.y + grip.height / 2 - bounds.y - bounds.height / 2)).toBeLessThan(1);
  }
  if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath("notion-image-side-grips.png") });
  await (await imageTools(page)).getByRole("button", { name: "Preview image", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "Image preview", exact: true });
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.locator("img").evaluate(node => node.naturalWidth)).toBe(640);
  if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath("notion-image-preview.png") });
  await preview.getByRole("button", { name: "Close image preview", exact: true }).click();
  await expect(preview).toBeHidden();
  await expect(page.locator(".ProseMirror")).toBeFocused();
  expect(await image.boundingBox()).toEqual(bounds);
  const tools = await imageTools(page);
  await tools.getByRole("button", { name: "Image actions", exact: true }).click();
  await expect(tools.getByRole("menuitem", { name: "Replace image", exact: true })).toBeVisible();
  if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath("notion-image-more-menu.png") });
  await tools.press("Escape");
  const left = await image.getByRole("button", { name: "Resize image from left", exact: true }).boundingBox();
  await page.mouse.move(left.x + left.width / 2, left.y + left.height / 2);
  await page.mouse.down();
  await page.mouse.move(left.x + 80, left.y + left.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator("#editor")).toHaveValue(/width:\d+px/);
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(page.locator("#editor")).toHaveValue('![Figure](images/figure.png "Original")\n\nTail paragraph.\n');
});

test("table handle deletion promotes headers without losing data and persists through preview and reload", async ({ page, browserName }) => {
  const source = "| Name | State | Owner |\n| --- | --- | --- |\n| A | Draft | One |\n| B | Ready | Two |\n\nTail.\n";
  await openFixture(page, "Table-contextual-save.md", source);
  const table = page.locator(".folio-table-wrapper");
  const menu = page.getByRole("menu", { name: "Table actions", exact: true });
  await table.locator("th").first().click();
  await openTableTools(page, 0, "row");
  await menu.getByRole("menuitem", { name: "Delete row", exact: true }).click();
  await expect(table.locator("tr")).toHaveCount(2);
  await expect(table.locator("th")).toHaveText(["A", "Draft", "One"]);
  await expect(table.locator("td")).toHaveText(["B", "Ready", "Two"]);
  await table.locator("th").last().click();
  await openTableTools(page);
  await menu.getByRole("menuitem", { name: "Delete column", exact: true }).click();
  await expect(table.locator("th")).toHaveText(["A", "Draft"]);
  await expect(table.locator("td")).toHaveText(["B", "Ready"]);
  await page.keyboard.press(`${primaryModifier}+s`);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  const saved = await fs.readFile(path.join(root, "Table-contextual-save.md"), "utf8");
  expect(saved).toContain("Draft");
  expect(saved).not.toContain("Owner");
  await chooseView(page, "preview");
  await expect(page.locator("#preview th")).toHaveText(["A", "Draft"]);
  if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath("notion-table-preview.png") });
  await chooseView(page, "rich");
  await page.reload();
  await expect(table.locator("td")).toHaveText(["B", "Ready"]);
  await expect(page.locator(".ProseMirror > p").last()).toHaveText("Tail.");
});
