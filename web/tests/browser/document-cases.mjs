import { test, expect, fs, path, root, buildRoot, initialText, chooseView, reloadDocument, openFixture, metadataField, confirmDialog, primaryModifier, documentEndShortcut } from "./fixture.mjs";

test("opening uses the metadata title instead of the nested markdown path", async ({ page }) => {
  await fs.mkdir(path.join(root, "Opening titles"), { recursive: true });
  await fs.writeFile(path.join(root, "Opening titles", "physical.v2.markdown"), "---\ntitle: Reading list\n---\n\n# Body\n");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const row = page.locator('button[data-path="Opening titles/physical.v2.markdown"]');
  await expect(row).toHaveText("Reading list");
  const folder = page.locator('details.directory[data-path="Opening titles"]');
  await expect(folder).toHaveJSProperty("open", false);
  await folder.locator(":scope > summary").click();
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  await page.route(/\/api\/document\?/, async route => { await hold; await route.continue(); });
  try {
    await row.click();
    await expect(page.locator("#loading-message")).toHaveText("Opening “Reading list”…");
  } finally { release(); }
  await expect(page).toHaveTitle("Reading list — Folio");
});

test("opens a rendered editable page without changing the Markdown", async ({ page, browserName }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const editor = page.locator(".ProseMirror[contenteditable=true]");
  await expect(editor).toBeVisible();
  const heading = editor.getByRole("heading", { name: "Welcome", exact: true });
  await expect(heading).toBeVisible();
  await expect(editor.locator("table")).toBeVisible();
  await expect(editor.locator("pre")).toContainText("fn main()");
  expect(await page.evaluate(() => performance.getEntriesByType("resource").map(r => new URL(r.name).pathname)
    .filter(p => p === "/formula.mjs" || p.startsWith("/math-fonts/")))).toEqual([]);
  const task = editor.locator("li").filter({ hasText: /A task/ });
  const checkbox = task.locator('input[type="checkbox"]');
  await expect(task).toContainText("A task");
  const boxBounds = await checkbox.boundingBox();
  const textBounds = await task.boundingBox();
  expect(boxBounds.y).toBeGreaterThanOrEqual(textBounds.y);
  expect(boxBounds.y - textBounds.y).toBeLessThan(20);
  expect(textBounds.height).toBeLessThan(55);
  const proseStyle = await editor.locator("p").filter({ hasText: /A local notebook/ }).evaluate((element) => ({
    size: Number.parseFloat(getComputedStyle(element).fontSize),
    family: getComputedStyle(element).fontFamily,
  }));
  expect(proseStyle.size).toBeGreaterThanOrEqual(16);
  expect(proseStyle.family).not.toMatch(/monospace/i);
  const image = editor.getByRole("img", { name: "Pixel" });
  await expect(image).toHaveAttribute("src", /\/assets\?id=[a-f0-9-]+&document=[a-f0-9-]+/i);
  await image.scrollIntoViewIfNeeded();
  await expect.poll(() => image.evaluate((element) => element.complete && element.naturalWidth > 0)).toBeTruthy();
  await expect(page.locator("#save-document")).toHaveCount(0);
  await expect(page.locator("#command-palette-open")).toBeHidden();
  await expect(page.locator("#connection-label")).toBeHidden();
  await expect(page.locator("#view-label")).toHaveText("Live");
  await expect(page.locator("#git-tab")).toHaveCount(0);
  await expect(page.getByText(/Change the folder in the desktop app/)).toHaveCount(0);
  expect(await fs.readFile(path.join(root, "README.md"), "utf8")).toBe(initialText);
  expect(page.url()).not.toContain("token=");
  expect(errors).toEqual([]);
  if (browserName !== "webkit") await page.screenshot({ path: path.join(buildRoot, "folio-editor.png"), fullPage: true });
});

test("inline edits save to disk and survive reopening in source mode", async ({ page }) => {
  const editor = page.locator(".ProseMirror[contenteditable=true]");
  await editor.evaluate((element) => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    element.focus();
  });
  await editor.press("Enter");
  await editor.pressSequentially("Written inline 中文");
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "dirty");
  await page.keyboard.press("Control+s");
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  await expect(page.locator("#document-message")).toBeHidden();
  const saved = await fs.readFile(path.join(root, "README.md"), "utf8");
  expect(saved).toContain("Written inline 中文");
  expect(saved).toContain("images/pixel.png");
  expect(saved).not.toContain("/assets?path");
  await page.reload();
  await editor.focus();
  await page.keyboard.press("Control+End");
  await expect(page.locator(".ProseMirror")).toContainText("Written inline 中文");
  await chooseView(page, "editor");
  await expect(page.locator("#editor")).toHaveValue(saved.replace(/\r\n/g, "\n"));
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
});

test("source changes switch to inline editing and auto-save after one second idle", async ({ page }) => {
  await chooseView(page, "editor");
  const content = "# Changed in source\n\nA **bold** paragraph.\n";
  await page.locator("#editor").fill(content);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "dirty");
  expect(await fs.readFile(path.join(root, "README.md"), "utf8")).toBe(initialText);
  await chooseView(page, "rich");
  await page.locator("#more-menu > button").focus();
  await expect(page.getByRole("heading", { name: "Changed in source", exact: true })).toBeVisible();
  await expect(page.locator(".ProseMirror")).toContainText("A bold paragraph.");
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  expect(await fs.readFile(path.join(root, "README.md"), "utf8")).toBe(content);
  await expect(page.locator("#document-message")).toBeHidden();
});

test("large Source documents use the virtual editor and save exact Unicode text", async ({ page }) => {
  const content = "# Virtual source\n\n"
    + Array.from({ length: 2_000 }, (_, index) =>
      `Line ${index} ${"with enough Markdown text for virtualization. ".repeat(10)}\n`).join("");
  await fs.writeFile(path.join(root, "Virtual-source.md"), content);
  await chooseView(page, "editor");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.locator('[data-path="Virtual-source.md"]').click();
  await expect(page.locator("#document-title")).toHaveText("Virtual-source");
  await expect(page.locator("#editor")).toBeHidden();
  const editor = page.locator(".virtual-source-editor .cm-content");
  await expect(editor).toBeVisible();
  for (const selector of [".virtual-source-editor", ".virtual-source-editor .cm-editor"]) {
    await expect(page.locator(selector)).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  }
  await expect(editor).toHaveAttribute("aria-label", "Markdown source");
  await editor.focus();
  await page.keyboard.press(documentEndShortcut);
  await page.keyboard.insertText("Written virtually 中文");
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "dirty");
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  await page.keyboard.press(`${primaryModifier}+Shift+z`);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "dirty");
  await page.keyboard.press(`${primaryModifier}+s`);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  expect(await fs.readFile(path.join(root, "Virtual-source.md"), "utf8"))
    .toBe(`${content}Written virtually 中文`);
  await expect.poll(() =>
    page.locator(".virtual-source-editor .cm-scroller")
      .evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await chooseView(page, "split");
  await expect(editor).toBeVisible();
  await expect(page.locator("#preview h1")).toHaveText("Virtual source");
  await page.keyboard.press(`${primaryModifier}+/`);
  await expect(page.locator(".ProseMirror[contenteditable=true]")).toBeVisible();
  await page.keyboard.press(`${primaryModifier}+/`);
  await expect(editor).toBeVisible();
});

test("cached editor analysis refreshes after edits and saved baselines", async ({ page }) => {
  await chooseView(page, "editor");
  await page.locator("#editor").fill("# Analysis\n\nThird line");
  await expect(page.locator("#editor-stats")).toHaveText("3 words");
  await expect(page.locator("#editor-stats")).toHaveAttribute("title", /^3 lines ·/);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "dirty");
  await page.keyboard.press("Control+s");
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator("#file-nav")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  await expect(page.locator("#editor-stats")).toHaveText("3 words");
  await expect(page.locator("#editor-stats")).toHaveAttribute("title", /^3 lines ·/);
});

test("Read reuses a current preview and refreshes it after source edits", async ({ page }) => {
  await chooseView(page, "editor");
  let previewRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/preview")) previewRequests += 1;
  });
  await chooseView(page, "preview");
  await expect(page.locator("#preview h1")).toHaveText("Welcome");
  const originalHeading = await page.locator("#preview h1").elementHandle();
  expect(previewRequests).toBe(1);

  await chooseView(page, "editor");
  await expect(page.locator(".preview-pane")).toBeHidden();
  await chooseView(page, "preview");
  expect(await page.evaluate(
    (node) => document.querySelector("#preview h1") === node,
    originalHeading,
  )).toBe(true);
  expect(previewRequests).toBe(1);

  await chooseView(page, "editor");
  await page.locator("#editor").fill("# Updated preview\n\nChanged body.\n");
  await chooseView(page, "preview");
  await expect(page.locator("#preview h1")).toHaveText("Updated preview");
  expect(previewRequests).toBe(2);

  await chooseView(page, "editor");
  await chooseView(page, "preview");
  await expect(page.locator("#preview h1")).toHaveText("Updated preview");
  expect(previewRequests).toBe(2);
});

test("Read outline jumps target scoped and escaped heading IDs", async ({ page }) => {
  const source = `${"Paragraph before the headings.\n\n".repeat(120)}# editor\n\n## 123 start\n`;
  await openFixture(page, "Preview-headings.md", source);
  await chooseView(page, "preview");
  const preview = page.locator("#preview");
  await page.locator("#outline-tab").click();
  await preview.evaluate((element) => { element.scrollTop = 0; });
  await page.locator("#outline-list").getByRole("button", { name: "editor", exact: true }).click();
  await expect.poll(() => preview.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await preview.evaluate((element) => { element.scrollTop = 0; });
  await page.locator("#outline-list").getByRole("button", { name: "123 start", exact: true }).click();
  await expect.poll(() => preview.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
});

test("Read links retain internal and external navigation behavior", async ({ page }) => {
  const origin = new URL(page.url()).origin;
  const source = "# Links\n\n"
    + "[Internal](Second.md)\n"
    + "[Anchor](#links)\n"
    + "[External](https://example.com/path)\n"
    + "[Email](mailto:user@example.com)\n"
    + `[Same origin](${origin}/plain)\n`;
  await openFixture(page, "Preview-links.md", source);
  await chooseView(page, "preview");
  const link = (name) => page.locator("#preview").getByRole("link", { name, exact: true });
  await expect(link("Internal")).not.toHaveAttribute("target");
  await expect(link("Anchor")).not.toHaveAttribute("target");
  await expect(link("Same origin")).not.toHaveAttribute("target");
  for (const name of ["External", "Email"]) {
    await expect(link(name)).toHaveAttribute("target", "_blank");
    await expect(link(name)).toHaveAttribute("rel", "noopener noreferrer");
  }
});

test("external disk edits follow Live, Source and Read without reopening the note", async ({ page }) => {
  const name = "Agent sync.md";
  const file = path.join(root, name);
  await openFixture(page, name, "First\n\nCaret here\n");
  const url = page.url();
  await fs.writeFile(file + ".tmp", "Second\n\nCaret here\n");
  await fs.rename(file + ".tmp", file);
  await expect(page.locator(".ProseMirror")).toContainText("Second");
  await chooseView(page, "editor");
  const source = page.locator("#editor");
  await source.focus();
  await source.evaluate(node => node.setSelectionRange(9, 9));
  await fs.writeFile(file, "Longer second\n\nCaret here\n");
  await expect(source).toHaveValue("Longer second\n\nCaret here\n");
  expect(await source.evaluate(node => node.selectionStart)).toBe(16);
  await expect(source).toBeFocused();
  await source.press(documentEndShortcut);
  await page.keyboard.insertText("Local word");
  await expect.poll(() => fs.readFile(file, "utf8")).toContain("Local word");
  await fs.writeFile(file, "From agent again\n\nCaret here\nLocal word");
  await expect(source).toHaveValue("From agent again\n\nCaret here\nLocal word");
  await source.press(`${primaryModifier}+z`);
  await expect(source).toHaveValue("From agent again\n\nCaret here\n");
  await source.press(`${primaryModifier}+s`);
  await expect.poll(() => fs.readFile(file, "utf8")).toBe("From agent again\n\nCaret here\n");
  await chooseView(page, "preview");
  await fs.writeFile(file, "# Reading an external change\n");
  await expect(page.locator("#preview")).toContainText("Reading an external change");
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  expect(page.url()).toBe(url);
});

test("a delayed disk read cannot overwrite newer local input", async ({ page }) => {
  await chooseView(page, "editor");
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  let captured;
  const received = new Promise(resolve => { captured = resolve; });
  const file = path.join(root, "README.md");
  await page.route(/\/api\/document\?.*&render=source$/, async route => {
    const reply = await route.fetch();
    if ((await reply.json()).content !== "# From agent\n") return route.fulfill({response: reply});
    captured();
    await hold;
    await route.fulfill({response: reply}).catch(() => {});
  });
  await fs.writeFile(file, "# From agent\n");
  await received;
  await page.locator("#editor").fill("# Local input\n");
  release();
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "conflict");
  await expect(page.locator("#editor")).toHaveValue("# Local input\n");
  expect(await fs.readFile(file, "utf8")).toBe("# From agent\n");
});

test("switching notes cancels an outstanding disk update", async ({ page }) => {
  let captured, release;
  const read = new Promise(resolve => { captured = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  await page.route(/\/api\/document\?.*&render=source$/, async route => {
    const response = await route.fetch();
    captured();
    await hold;
    await route.fulfill({ response }).catch(() => {});
  }, {times: 1});
  await fs.writeFile(path.join(root, "README.md"), "# Old note updated\n");
  await read;
  await page.locator("#file-list").getByRole("button", {name: "Second.md", exact: true}).click();
  await expect(page.locator(".ProseMirror")).toContainText("Another note");
  release();
  await expect(page.locator("#document-title")).toHaveText("Second");
});

test("external changes cause a conflict without losing editor text", async ({ page }) => {
  await chooseView(page, "editor");
  await page.locator("#editor").fill("# My unsaved work\n");
  await fs.writeFile(path.join(root, "README.md"), "# Changed elsewhere\n");
  await page.keyboard.press("Control+s");
  await expect(page.locator("#conflict-message")).toBeVisible();
  await expect(page.locator("#dirty-indicator")).toBeHidden();
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "conflict");
  await expect(page.locator("#document-title")).toHaveText("README *");
  await expect(page.locator("#editor")).toHaveValue("# My unsaved work\n");
  expect(await fs.readFile(path.join(root, "README.md"), "utf8")).toBe("# Changed elsewhere\n");
  await page.getByRole("button", {name: "Copy my edits"}).click();
  await expect(page.locator("#conflict-copy")).toHaveText("Copied");
  await page.getByRole("button", { name: "Use latest", exact: true }).click();
  await expect(page.getByRole("button", {name: "Keep editing"})).toBeFocused();
  await confirmDialog(page, { accept: false });
  await expect(page.locator("#editor")).toHaveValue("# My unsaved work\n");
  await page.getByRole("button", { name: "Use latest", exact: true }).click();
  await confirmDialog(page);
  await expect(page.locator("#editor")).toHaveValue("# Changed elsewhere\n");
  await expect(page.locator(".document-conflict")).toBeHidden();
});

test("cancelled navigation after a save failure retains unsaved text", async ({ page }) => {
  await chooseView(page, "editor");
  await page.route("**/api/document", route => route.request().method() === "PUT"
    ? route.fulfill({ status: 500, json: { error: "Save is temporarily unavailable." } }) : route.continue());
  await page.locator("#editor").fill("# Keep me\n");
  await page.locator("#file-list").getByRole("button", { name: "Second.md", exact: true }).click();
  await confirmDialog(page, { accept: false });
  await expect(page.locator("#document-title")).toHaveText("README *");
  await expect(page.locator("#editor")).toHaveValue("# Keep me\n");
});

test("a completed save does not erase typing that happened during the request", async ({ page }) => {
  await chooseView(page, "editor");
  await page.locator("#editor").fill("# First snapshot\n");
  let releaseResponse;
  const heldResponse = new Promise((resolve) => { releaseResponse = resolve; });
  let receivedRequest;
  const requestArrived = new Promise((resolve) => { receivedRequest = resolve; });
  await page.route("**/api/document", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    const response = await route.fetch();
    receivedRequest();
    await heldResponse;
    await route.fulfill({ response });
  });
  try {
    await page.keyboard.press("Control+s");
    await requestArrived;
    await page.locator("#editor").fill("# Newer unsaved work\n");
  } finally {
    releaseResponse();
  }
  await expect(page.locator("#editor")).toHaveValue("# Newer unsaved work\n");
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "dirty");
  expect(await fs.readFile(path.join(root, "README.md"), "utf8")).toBe("# First snapshot\n");
});

test("raw HTML remains inert and editable without executing", async ({ page }) => {
  await page.locator("#file-list").getByRole("button", { name: "Unsupported.md", exact: true }).click();
  await expect(page.locator("#document-title")).toHaveText("Unsupported");
  await expect(page.locator("#rich-warning")).toBeHidden();
  await expect(page.locator("#document-panes")).toHaveAttribute("data-view", "rich");
  await expect(page.locator('.ProseMirror [data-type="html"]')).toContainText("<div>");
  await expect(page.locator(".ProseMirror div:not(.ProseMirror)")).toHaveCount(0);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  expect(await fs.readFile(path.join(root, "Unsupported.md"), "utf8")).toBe("# Source\n\n<div>Keep this HTML</div>\n");
});

test("creating a note never overwrites an existing file", async ({ page }) => {
  await page.locator("#new-menu > button").click(); await page.locator("#new-from-template").click();
  await page.locator("#new-note-title").fill("Second");
  await page.locator("#create-note").click();
  await expect(page.locator("#new-note-error")).toBeVisible();
  expect(await fs.readFile(path.join(root, "Second.md"), "utf8")).toBe("# Second\n\nAnother note.\n");
  await page.locator("#new-note-title").fill("New note");
  await page.locator("#create-note").click();
  await expect(page.locator("#document-title")).toHaveText("New note");
  await expect(page).toHaveTitle("New note — Folio");
  await expect(page.locator(".ProseMirror[contenteditable=true]")).toBeVisible();
  expect(await fs.readFile(path.join(root, "New note.md"), "utf8")).toMatch(
    /^---\ntitle: "New note"\ncreated: "\d{4}-\d{2}-\d{2}T[\d:.]+Z"\n---\n\n$/,
  );
});

test("metadata titles and folder actions support rename and drag moves", async ({ page }) => {
  await fs.mkdir(path.join(root, "Guides"));
  await fs.mkdir(path.join(root, "Empty"));
  await fs.writeFile(path.join(root, "Guides", "index.md"), "---\ntitle: Handbook\n---\n# Index\n");
  await fs.writeFile(path.join(root, "Guides", "intro.md"), "---\ntitle: Getting started\n---\n# Intro\n");
  await page.reload();

  const guides = page.locator('details.directory[data-path="Guides"] > summary');
  await expect(guides).toContainText("Handbook");
  await expect(page.locator('details.directory[data-path="Empty"] > summary')).toBeVisible();
  await expect(page.locator('button[data-path="Guides/intro.md"]')).toHaveText("Getting started");

  await guides.hover();
  await guides.getByRole("button", { name: "Add in Handbook" }).click();
  await page.getByRole("menuitem", { name: "New folder" }).click();
  const folderName = page.getByRole("textbox", { name: "Folder name" });
  await expect(folderName).toBeFocused();
  expect(await fs.readdir(path.join(root, "Guides"))).not.toContain("New folder");
  await folderName.fill("Child");
  await folderName.press("Enter");
  await expect(page.locator('details.directory[data-path="Guides/Child"] > summary')).toBeVisible();

  await page.locator('button[data-path="Guides/intro.md"]').hover();
  await page.getByRole("button", { name: "Add in Getting started" }).click();
  await page.getByRole("menuitem", { name: "New note" }).click();
  const fileName = page.getByRole("textbox", { name: "File name" });
  await expect(fileName).toBeFocused();
  expect(await fs.readdir(path.join(root, "Guides"))).not.toContain("Untitled.md");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await fileName.fill("intro.md");
  await fileName.press("Enter");
  await expect(fileName).toHaveAttribute("aria-invalid", "true");
  await fileName.fill("Draft");
  await fileName.press("Enter");

  const draft = page.locator('button[data-path="Guides/Draft.md"]');
  await expect(draft).toBeFocused();
  await draft.click();
  await draft.click({ button: "right" });
  await page.locator("#file-details").click();
  await expect(page.locator("#details-path")).toHaveText("Guides/Draft.md");
  await page.locator("#close-details").click();

  await draft.click({ button: "right" });
  await page.locator("#file-rename").click();
  await expect(fileName).toBeFocused();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await fileName.fill("Renamed");
  await fileName.press("Enter");
  const renamed = page.locator('button[data-path="Guides/Renamed.md"]');
  await expect(renamed).toBeVisible();
  await expect(page.locator("#document-title")).toContainText("Renamed");
  expect(await fs.stat(path.join(root, "Guides", "Renamed.md"))).toBeTruthy();

  const child = page.locator('details.directory[data-path="Guides/Child"] > summary');
  const restingFill = await child.evaluate(node => getComputedStyle(node).backgroundColor);
  await renamed.hover();
  await page.mouse.down();
  await child.hover();
  await child.hover(); // Browsers may need a second movement to dispatch dragover.
  await expect(child.locator("..")).toHaveAttribute("data-drop-target", "true");
  await expect(child).not.toHaveCSS("background-color", restingFill);
  await expect(child).toHaveCSS("box-shadow", "none");
  await page.mouse.up();
  await expect(page.locator('button[data-path="Guides/Child/Renamed.md"]')).toBeVisible();
  await expect(page.locator("#document-title")).toContainText("Renamed");
  expect(await fs.stat(path.join(root, "Guides", "Child", "Renamed.md"))).toBeTruthy();

  await page.locator('button[data-path="Guides/intro.md"]').click();
  await expect(page.locator("#document-title")).toHaveText("Getting started");
  await expect(page).toHaveTitle("Getting started — Folio");
});

test("live typing retains heading and emphasis formatting instead of expanding Markdown", async ({ page }) => {
  const editor = page.locator(".ProseMirror");
  const heading = editor.getByRole("heading", { name: "Welcome", exact: true });
  const appearance = await heading.evaluate((element) => ({
    size: getComputedStyle(element).fontSize,
    weight: getComputedStyle(element).fontWeight,
  }));
  await heading.click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" edited");
  await expect(editor.locator("h1")).toHaveText("Welcome edited");
  expect(await editor.locator("h1").evaluate((element) => ({
    size: getComputedStyle(element).fontSize,
    weight: getComputedStyle(element).fontWeight,
  }))).toEqual(appearance);
  await expect(page.locator("#document-panes")).toHaveAttribute("data-view", "rich");
  await expect(page.locator("#editor")).toBeHidden();
  await expect(editor).not.toContainText("# Welcome");
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(page.locator("#editor")).toHaveValue(initialText);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  await editor.locator("strong").click();
  await page.keyboard.insertText("new");
  await expect(editor.locator("strong")).toContainText("new");
  await expect(editor).not.toContainText("**");
  expect(await fs.readFile(path.join(root, "README.md"), "utf8")).toBe(initialText);
});

test("the sidebar can hide and outline navigation does not change the note", async ({ page }) => {
  await page.locator("#outline-tab").click();
  await page.locator("#outline-list").getByRole("button", { name: "Welcome", exact: true }).click();
  await expect(page.locator(".ProseMirror h1")).toHaveText("Welcome");
  await expect(page.locator(".ProseMirror")).not.toContainText("# Welcome");
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  await page.locator("#sidebar-hide").click();
  await expect(page.locator("#sidebar")).toBeHidden();
  await expect(page.locator("#sidebar-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#sidebar-toggle")).toBeFocused();
  await page.keyboard.press("Control+Shift+l");
  await expect(page.locator("#sidebar")).toBeVisible();
  await expect(page.locator("#sidebar-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#sidebar-toggle")).toBeHidden();
  await expect(page.locator("#sidebar-hide")).toBeFocused();
  await page.keyboard.press("Control+/");
  await expect(page.locator("#editor")).toBeVisible();
  await expect(page.locator("#outline-list")).toContainText("Welcome");
  await page.locator("#editor").fill("# Updated outline\n\nA paragraph.\n");
  await expect(page.locator("#outline-list")).toContainText("Updated outline");
  await page.locator("#editor").fill(initialText);
  await page.keyboard.press("Control+/");
  await expect(page.locator(".ProseMirror")).toBeVisible();
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
});
