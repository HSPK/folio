import { test, expect, fs, path, root, chooseView, confirmDialog, openFixture, primaryModifier, openSettingsDialog, openMoreAction, selectSettingsSection } from "./fixture.mjs";
import { collaborativeLibrary } from "./collaboration-cases.mjs";
import { writeClipboardImage } from "./project-cases.mjs";

async function pasteTestImage(locator) {
  await locator.evaluate(async (target) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 8;
    canvas.getContext("2d").fillRect(0, 0, 8, 8);
    const transfer = new DataTransfer();
    transfer.items.add(new File([await new Promise(resolve => canvas.toBlob(resolve, "image/png"))], "test.png", { type: "image/png" }));
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: transfer });
    target.dispatchEvent(paste);
  });
}

async function holdImageUploads(page) {
  const requests = [];
  await page.route(/\/api\/images\?/, route => { requests.push(route); });
  return requests;
}

test("Live previews a slow paste locally; completion preserves typing, composition and selection", async ({ page }) => {
  await openFixture(page, "Slow-Live-image.md", "LeftRight\n\nOther line\n");
  const requests = await holdImageUploads(page);
  const body = page.locator(".ProseMirror");
  await body.focus();
  await body.locator("p").first().evaluate(p => getSelection().collapse(p.firstChild, 4));
  await pasteTestImage(body);
  const preview = body.locator(".folio-pending-image");
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.locator("canvas").evaluate(c => c.getContext("2d").getImageData(48, 32, 1, 1).data[3])).toBe(255);
  await page.keyboard.type("new");
  await expect(page.locator("#editor")).toHaveValue(/^LeftnewRight/);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  expect(await fs.readFile(path.join(root, "Slow-Live-image.md"), "utf8")).not.toMatch(/blob:|Saving image|!\[/);
  await body.locator("p").last().evaluate(p => getSelection().setBaseAndExtent(p.firstChild, 5, p.firstChild, 0));
  await body.dispatchEvent("compositionstart", { bubbles: true });
  const response = page.waitForResponse(/\/api\/images\?/);
  await requests[0].continue();
  await response;
  await expect(preview).toBeVisible();
  await body.dispatchEvent("compositionend", { bubbles: true });
  await expect(preview).toHaveCount(0);
  await expect(page.locator("#editor")).toHaveValue(/^Left!\[Image\]\([^)]+\)newRight/);
  expect(await page.evaluate(() => getSelection().toString())).toBe("Other");
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(body.locator(".folio-inline-image")).toHaveCount(0);
  await expect(page.locator("#editor")).toHaveValue(/^LeftnewRight/);
});

test("Source maps simultaneous slow pastes and keeps the writer's newer backward selection", async ({ page }) => {
  await openFixture(page, "Slow-Source-image.md", "left:OLD:right\n");
  await chooseView(page, "editor");
  const source = page.locator("#editor");
  await source.focus();
  const requests = await holdImageUploads(page);
  await source.evaluate(e => e.setSelectionRange(5, 8));
  await pasteTestImage(source);
  await page.keyboard.insertText("typed");
  await source.evaluate(e => e.setSelectionRange(0, 0));
  await page.keyboard.insertText("prefix:");
  await pasteTestImage(source);
  await expect.poll(() => requests.length).toBe(2);
  await source.evaluate(e => {
    const start = e.value.indexOf("right");
    e.setSelectionRange(start, start + 5, "backward");
  });
  await requests[1].continue();
  await expect(source).toHaveValue(/^prefix:!\[Image\]\([^)]+\)left:OLDtyped:right/);
  await requests[0].continue();
  await expect(source).toHaveValue(/^prefix:!\[Image\]\([^)]+\)left:!\[Image\]\([^)]+\)typed:right/);
  expect(await source.evaluate(e => [e.value.slice(e.selectionStart, e.selectionEnd), e.selectionDirection])).toEqual(["right", "backward"]);
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(source).toHaveValue(/^prefix:!\[Image\]\([^)]+\)left:OLDtyped:right/);
});

test("pending Live pastes cancel on undo and deletion; failed uploads leave text alone", async ({ page }) => {
  await openFixture(page, "Canceled-image.md", "Keep this\n");
  const requests = await holdImageUploads(page);
  const body = page.locator(".ProseMirror");
  await body.focus();
  for (const key of [`${primaryModifier}+z`, "Backspace"]) {
    const count = requests.length;
    await pasteTestImage(body);
    await expect.poll(() => requests.length).toBe(count + 1);
    await expect(body.locator(".folio-pending-image")).toHaveCount(1);
    await page.keyboard.press(key);
    await expect(body.locator(".folio-pending-image")).toHaveCount(0);
    await expect(page.locator("#editor")).toHaveValue("Keep this\n");
  }
  const already = requests.length;
  await pasteTestImage(body);
  await expect.poll(() => requests.length).toBe(already + 1);
  await requests.at(-1).fulfill({ status: 500, json: { error: "upload test failure" } });
  await expect(body.locator(".folio-pending-image")).toHaveCount(0);
  await expect(page.getByText("Image insert failed: upload test failure")).toBeVisible();
  await expect(page.locator("#editor")).toHaveValue("Keep this\n");
});

test("pending Live previews stay private and map past another writer's edits", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { content: "First\n\nLast\n" });
  try {
    const [owner, peer] = library.pages;
    const requests = await holdImageUploads(owner);
    const body = owner.locator(".ProseMirror");
    await body.focus();
    await body.locator("p").last().evaluate(p => getSelection().collapse(p.firstChild, 2));
    await pasteTestImage(body);
    await expect(body.locator(".folio-pending-image")).toHaveCount(1);
    await expect(peer.locator(".folio-pending-image, .folio-inline-image")).toHaveCount(0);
    await peer.locator(".ProseMirror").focus();
    await peer.locator(".ProseMirror p").first().evaluate(p => getSelection().collapse(p.firstChild, 0));
    await peer.keyboard.insertText("Peer: ");
    await expect(owner.locator("#editor")).toHaveValue(/^Peer: First/);
    await expect(body.locator(".folio-pending-image")).toHaveCount(1);
    await requests[0].continue();
    for (const page of library.pages)
      await expect(page.locator("#editor")).toHaveValue(/^Peer: First\n\nLa!\[Image\]\([^)]+\)st/);
  } finally { await library.close(); }
});

test("a pending upload cannot place an image or display its response after switching notes", async ({ page }) => {
  await openFixture(page, "Leaving-image.md", "Leave me unchanged\n");
  const requests = await holdImageUploads(page);
  const body = page.locator(".ProseMirror");
  await body.focus();
  await pasteTestImage(body);
  await expect(body.locator(".folio-pending-image")).toBeVisible();
  await expect.poll(() => requests.length).toBe(1);
  await page.locator('#file-list [data-path="Second.md"]').click();
  await expect(page.locator("#editor")).toHaveValue(/Second/);
  await requests[0].fulfill({ status: 500, json: { error: "old-note-response" } });
  await expect(body.locator(".folio-pending-image, .folio-inline-image")).toHaveCount(0);
  await expect(page.getByText(/old-note-response/)).toHaveCount(0);
  expect(await fs.readFile(path.join(root, "Leaving-image.md"), "utf8")).toBe("Leave me unchanged\n");
});

test("daily templates create tagged notes and dropped images respect compression settings", async ({ page }) => {
  await page.locator("#new-menu > button").click(); await page.locator("#new-from-template").click();
  await page.locator("#new-note-template").selectOption("daily");
  const title = await page.locator("#new-note-title").inputValue();
  expect(title).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  const name = `${title}.md`;
  await page.locator("#create-note").click();
  await expect(page.locator(".ProseMirror")).toContainText("Priorities");
  expect(await fs.readFile(path.join(root, name), "utf8")).toContain("tags: [journal]");
  await openSettingsDialog(page);
  await selectSettingsSection(page, "library");
  await page.locator("#settings-image-compression").selectOption("jpeg");
  await page.locator("#settings-image-max-edge").selectOption("1024");
  await page.locator("#settings-save").click();
  const transfer = await page.evaluateHandle(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 2048;
    canvas.height = 1024;
    canvas.getContext("2d").fillRect(0, 0, 2048, 1024);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], "drop.png", { type: "image/png" }));
    return transfer;
  });
  const body = page.locator(".ProseMirror");
  const bounds = await body.boundingBox();
  await body.dispatchEvent("drop", { dataTransfer: transfer, clientX: bounds.x + 20, clientY: bounds.y + 20 });
  await expect(page.locator(".folio-inline-image img")).toHaveCount(1);
  const image = page.locator(".folio-inline-image img");
  await expect(image).toHaveAttribute("src", /\/assets\?id=[a-f0-9-]+&document=[a-f0-9-]+/);
  const asset = await page.request.get(new URL(await image.getAttribute("src"), page.url()).href);
  expect(asset.ok()).toBe(true);
  expect(asset.headers()["content-type"]).toMatch(/^image\/jpeg/);
  await expect.poll(() => image.evaluate((node) => [node.naturalWidth, node.naturalHeight])).toEqual([1024, 512]);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  expect(await fs.readFile(path.join(root, name), "utf8")).toMatch(/\.jpg(?:\)|")/);
});

test("pasting an image after an image, ArrowRight and Enter stays in Live without HTML placeholders", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Native clipboard setup requires Chromium clipboard permissions.");
  await openFixture(page, "Image-enter-paste.md", "![First](images/pixel.png)\n\nTail paragraph.\n");
  await writeClipboardImage(page);
  const first = page.locator(".folio-inline-image").first();
  await first.click();
  await expect(first).toHaveClass(/ProseMirror-selectednode/);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await expect(page.locator(".ProseMirror")).toBeFocused();
  await expect(page.locator("#editor")).not.toHaveValue(/<br\b/i);
  await page.keyboard.press(`${primaryModifier}+v`);
  await expect(page.locator("#document-panes")).toHaveAttribute("data-view", "rich");
  await expect(page.locator(".folio-inline-image img")).toHaveCount(2);
  await expect(page.locator(".ProseMirror > .folio-block-image img")).toHaveCount(1);
  await expect(page.locator("#editor")).not.toHaveValue(/<br\b/i);
  await expect(page.locator(".ProseMirror")).toContainText("Tail paragraph.");
  await page.keyboard.press(`${primaryModifier}+s`);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  const saved = await fs.readFile(path.join(root, "Image-enter-paste.md"), "utf8");
  expect(saved).not.toMatch(/<br\b/i);
  expect(saved.match(/!\[|<img\b/g)).toHaveLength(2);
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(page.locator(".folio-inline-image img")).toHaveCount(1);
  await page.keyboard.press(`${primaryModifier}+Shift+z`);
  await expect(page.locator(".folio-inline-image img")).toHaveCount(2);
  await expect(page.locator("#document-panes")).toHaveAttribute("data-view", "rich");
  if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath("live-image-enter-paste.png"), animations: "disabled" });
});

test("shared image paste keeps the new paragraph and preserves literal br inside code", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "Native clipboard setup requires Chromium clipboard permissions.");
  const content = "![First](first.png)\n\nTail paragraph.\n\n```html\n<br />\n```\n";
  const library = await collaborativeLibrary(browser, { content });
  try {
    const [owner, peer] = library.pages;
    await fs.writeFile(path.join(library.notes, "first.png"), await fs.readFile(path.join(root, "images/pixel.png")));
    await writeClipboardImage(owner);
    const first = owner.locator(".folio-inline-image").first();
    await first.click();
    await expect(first).toHaveClass(/ProseMirror-selectednode/);
    await owner.keyboard.press("ArrowRight");
    await owner.keyboard.press("Enter");
    await owner.keyboard.press(`${primaryModifier}+v`);
    for (const page of [owner, peer]) {
      await expect(page.locator(".folio-inline-image img")).toHaveCount(2);
      await expect(page.locator("#document-panes")).toHaveAttribute("data-view", "rich");
      await expect(page.locator("#editor")).toHaveValue(/```html\n<br \/>\n```/);
    }
    await owner.keyboard.press(`${primaryModifier}+s`);
    await expect(owner.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    const saved = await fs.readFile(path.join(library.notes, "Shared.md"), "utf8");
    expect(saved.match(/!\[|<img\b/g)).toHaveLength(2);
    expect(saved.match(/<br\b/gi)).toHaveLength(1);
  } finally { await library.close(); }
});

test("attachment cleanup only recycles confirmed unreferenced files and can restore them", async ({ browser }) => {
  const library = await collaborativeLibrary(browser);
  try {
    const [owner, member] = library.pages;
    const base64 = await owner.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 8;
      canvas.height = 8;
      return canvas.toDataURL("image/png").split(",")[1];
    });
    await fs.writeFile(path.join(library.notes, "orphan.png"), Buffer.from(base64, "base64"));
    await fs.writeFile(path.join(library.notes, "used.png"), Buffer.from(base64, "base64"));
    await fs.writeFile(path.join(library.notes, "Other.md"), "# Other\n\n![Used](used.png)\n");
    await member.close({ runBeforeUnload: false });
    await openMoreAction(owner, "collaboration-join");
    await expect(owner.locator("#collaboration-join")).toHaveText("Collaborate");
    await owner.locator("#more-menu > button").click();
    await owner.locator("#attachments-open").click();
    await expect(owner.locator("#attachments-list")).toContainText("orphan.png");
    await expect(owner.locator("#attachments-list")).not.toContainText("used.png");
    await owner.getByRole("checkbox", { name: "Select orphan.png", exact: true }).check();
    await owner.locator("#attachments-recycle").click();
    await confirmDialog(owner);
    await expect(owner.locator("#attachments-list")).not.toContainText("orphan.png");
    expect(await fs.stat(path.join(library.notes, "orphan.png")).then(() => true, () => false)).toBe(false);
    expect(await fs.stat(path.join(library.notes, "used.png")).then(() => true, () => false)).toBe(true);
    await owner.locator("#attachments-close").click();
    await openMoreAction(owner, "trash-open");
    await owner.getByRole("button", { name: "Restore orphan.png", exact: true }).click();
    await expect(owner.locator("#trash-list")).not.toContainText("orphan.png");
    expect(await fs.readFile(path.join(library.notes, "orphan.png"))).toEqual(Buffer.from(base64, "base64"));
  } finally { await library.close(); }
});
