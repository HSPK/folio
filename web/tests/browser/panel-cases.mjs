import { chromium } from "@playwright/test";
import { test, expect, fs, path, root, confirmDialog, openFixture, openMoreAction, userResourceId } from "./fixture.mjs";
import { collaborativeLibrary } from "./collaboration-cases.mjs";

import { workbook, largePdf } from "./panel-fixture.mjs";

test("native PDF previews stream large files with authenticated ranges and validators", async ({ page, browser }) => {
  const bytes = largePdf(await page.pdf());
  await fs.writeFile(path.join(root, "large.pdf"), bytes);
  const url = new URL("/assets/pdf?path=large.pdf", page.url()).href;
  const first = await page.request.get(url, { headers: { Range: "bytes=0-4" } });
  expect(first.status()).toBe(206);
  expect(await first.body()).toEqual(Buffer.from("%PDF-"));
  expect(first.headers()["content-range"]).toBe(`bytes 0-4/${bytes.length}`);
  expect(first.headers()["content-type"]).toBe("application/pdf");
  expect(first.headers()["x-frame-options"]).toBe("SAMEORIGIN");
  expect(first.headers()["content-security-policy"]).toContain("frame-ancestors 'self'");
  const tail = await page.request.get(url, { headers: { Range: "bytes=-1024" } });
  expect(tail.status()).toBe(206);
  expect(await tail.body()).toEqual(bytes.subarray(-1024));
  const head = await page.request.head(url);
  expect(head.status()).toBe(200);
  expect(head.headers()["content-length"]).toBe(String(bytes.length));
  expect((await head.body()).length).toBe(0);
  const unchanged = await page.request.get(url, { headers: { "If-None-Match": first.headers().etag } });
  expect(unchanged.status()).toBe(304);
  const stale = await page.request.head(url, { headers: { Range: "bytes=0-4", "If-Range": '"stale"' } });
  expect(stale.status()).toBe(200);
  expect(stale.headers()["content-length"]).toBe(String(bytes.length));
  const invalid = await page.request.get(url, { headers: { Range: `bytes=${bytes.length}-` } });
  expect(invalid.status()).toBe(416);
  expect(invalid.headers()["content-range"]).toBe(`bytes */${bytes.length}`);
  const guest = await browser.newContext();
  try { expect((await guest.request.get(url)).status()).toBe(401); }
  finally { await guest.close(); }
  await fs.writeFile(path.join(root, "invalid.pdf"), "not a PDF");
  expect((await page.request.get(url.replace("large.pdf", "invalid.pdf"))).status()).toBe(400);
});

test("workspace panels preserve source bytes, reject stale saves, and open PDF and XLSX outside Markdown", async ({
  page,
}) => {
  const dir = path.join(root, "Panel files");
  await fs.mkdir(dir);
  const code = path.join(dir, "sample.py");
  await fs.writeFile(code, "\ufeffprint(1)\r\n");
  const pdf = await page.pdf();
  await fs.writeFile(path.join(dir, "report.pdf"), pdf);
  await fs.writeFile(path.join(dir, "book.xlsx"), workbook());
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.locator('summary[data-entry-path="Panel files"]').click();
  const open = (name) => page.getByRole("button", { name: "Panel files/" + name, exact: true }).click();
  const panel = page.locator("#workspace-file-panel");
  await open("sample.py");
  const editor = panel.getByRole("textbox", { name: "Source code" });
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(page.locator("#document-panes")).toBeHidden();
  await expect(page.getByRole("button", { name: "Panel files/sample.py", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  const sourceText = () => editor.evaluate((el) => el.value ?? el.innerText);
  await expect.poll(sourceText).toContain("print(1)");
  await editor.fill("print(2)\n");
  await editor.press("Control+s");
  await expect(panel.getByRole("status")).toHaveText("Saved");
  expect(await fs.readFile(code, "utf8")).toBe("\ufeffprint(2)\r\n");
  await fs.writeFile(code, "external\n");
  await editor.fill("mine");
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("changed on disk");
  await expect.poll(sourceText).toContain("mine");
  await open("book.xlsx");
  await confirmDialog(page, { accept: false });
  await expect.poll(sourceText).toContain("mine");
  expect(await fs.readFile(code, "utf8")).toBe("external\n");
  await fs.unlink(code);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(panel.getByRole("status")).toContainText("moved or deleted");
  await expect.poll(sourceText).toContain("mine");
  await open("book.xlsx");
  await confirmDialog(page);
  await expect(panel.getByRole("cell", { name: "Region 1" })).toBeVisible();
  const south = panel.getByRole("tab", { name: "South" });
  const grid = await panel.getByRole("tabpanel").boundingBox(),
    tab = await south.boundingBox();
  expect(tab.y).toBeGreaterThanOrEqual(grid.y + grid.height);
  await south.click();
  await expect(panel.getByRole("cell", { name: "Region 2" })).toBeVisible();
  await expect(south).toHaveAttribute("aria-selected", "true");
  await expect(panel.getByRole("textbox")).toHaveCount(0);
  await open("report.pdf");
  const pdfBox = await panel.locator(".file-panel-surface").boundingBox(), sidebarBox = await page.locator("#sidebar").boundingBox();
  expect(Math.abs(pdfBox.y - sidebarBox.y)).toBeLessThan(1);
  expect(Math.abs(pdfBox.height - sidebarBox.height)).toBeLessThan(1);
  await expect(panel.getByRole("button", { name: "Close file panel" })).toHaveCount(0);
  const link = panel.getByRole("link", { name: "Download PDF" });
  const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
  expect(await fs.readFile(await download.path())).toEqual(pdf);
  await page.getByRole("button", { name: "README.md", exact: true }).click();
  await expect(panel).toBeHidden();
  await expect(page.locator("#document-panes")).toBeVisible();
  await expect(page.locator("#document-title")).toHaveText("README");
});

test("all file types have context actions, editable properties and an independent icon picker", async ({ page }) => {
  const bytes = workbook();
  const pdf = await page.pdf();
  await fs.writeFile(path.join(root, "Actions.xlsx"), bytes);
  await fs.writeFile(path.join(root, "Actions.pdf"), pdf);
  await fs.writeFile(path.join(root, "Actions.py"), "print(42)\n");
  await fs.writeFile(path.join(root, "Action-note.md"), "# Context target\n");
  const originalNote = await fs.readFile(path.join(root, "README.md"), "utf8");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const menu = page.getByRole("menu", { name: "File actions" });
  const row = (name) => page.locator(`[data-entry-path="${name}"]`);
  for (const name of ["Actions.xlsx", "Actions.pdf", "Actions.py"]) {
    await row(name).click({ button: "right" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Properties", exact: true })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Download", exact: true })).toBeVisible();
    await expect(menu.locator("#file-icon-choices")).toHaveCount(0);
    await page.keyboard.press("Escape");
  }
  await row("Actions.xlsx").locator(".tree-entry-icon").click();
  const icons = page.getByRole("dialog", { name: "Choose icon" });
  await expect(icons).toBeVisible();
  await icons.getByRole("menuitemradio", { name: "Icon: table", exact: true }).click();
  await expect(icons).toBeHidden();
  await expect(row("Actions.xlsx").locator('svg[data-icon="table"]')).toBeVisible();
  await expect(page.locator("#workspace-file-panel")).toBeHidden();
  await row("Actions.xlsx").click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Properties", exact: true }).click();
  await page.locator("#file-property-title").fill("Report");
  await page.locator("#file-property-tags").fill("review, finance");
  await page.locator("#file-property-description").fill("Quarterly workbook");
  await page.locator("#file-properties-save").click();
  await expect(page.locator("#details-dialog")).toBeHidden();
  await page.reload();
  await row("Actions.xlsx").click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Properties", exact: true }).click();
  await expect(page.locator("#file-property-title")).toHaveValue("Report");
  await expect(page.locator("#file-property-tags")).toHaveValue("review, finance");
  await page.locator("#close-details").click();
  await row("Actions.xlsx").click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Rename", exact: true }).click();
  const rename = page.getByRole("textbox", { name: "File name", exact: true });
  await rename.fill("Renamed.xlsx");
  await rename.press("Enter");
  await expect(row("Renamed.xlsx")).toBeVisible();
  await expect(row("Renamed.xlsx").locator('svg[data-icon="table"]')).toBeVisible();
  await row("Renamed.xlsx").click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Properties", exact: true }).click();
  await expect(page.locator("#file-property-title")).toHaveValue("Report");
  await page.locator("#close-details").click();
  await row("Renamed.xlsx").click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Duplicate", exact: true }).click();
  await expect(rename).toHaveValue("Renamed copy.xlsx");
  await rename.press("Escape");
  await expect(row("Renamed copy.xlsx")).toBeVisible();
  await expect(row("Renamed copy.xlsx").locator('svg[data-icon="table"]')).toBeVisible();
  expect(await fs.readFile(path.join(root, "Renamed copy.xlsx"))).toEqual(bytes);
  await row("Renamed copy.xlsx").click({ button: "right" });
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    menu.getByRole("menuitem", { name: "Download", exact: true }).click(),
  ]);
  expect(await fs.readFile(await download.path())).toEqual(bytes);
  await row("Renamed copy.xlsx").click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Recycle", exact: true }).click();
  await confirmDialog(page);
  await expect(row("Renamed copy.xlsx")).toHaveCount(0);
  await openMoreAction(page, "trash-open");
  await page.getByRole("button", { name: "Restore Renamed copy.xlsx", exact: true }).click();
  await expect(page.getByRole("button", { name: "Restore Renamed copy.xlsx", exact: true })).toHaveCount(0);
  await page.locator("#trash-close").click();
  await expect(row("Renamed copy.xlsx")).toBeVisible();
  expect(await fs.readFile(path.join(root, "Renamed copy.xlsx"))).toEqual(bytes);
  await row("Renamed copy.xlsx").click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Properties", exact: true }).click();
  await expect(page.locator("#file-property-title")).toHaveValue("Report");
  await expect(page.locator("#file-property-tags")).toHaveValue("review, finance");
  await page.locator("#close-details").click();
  expect(await fs.readFile(path.join(root, "Renamed.xlsx"))).toEqual(bytes);
  await row("Action-note.md").click({ button: "right" });
  await expect(menu.getByRole("menuitem", { name: "Edit tags", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Copy Markdown", exact: true })).toBeVisible();
  await menu.getByRole("menuitem", { name: "Edit tags", exact: true }).click();
  await expect(page.locator("#tags-dialog")).toBeVisible();
  await page.locator("#tags-input").fill("context-tag");
  await page.locator("#tags-dialog button[type=submit]").click();
  await expect.poll(() => fs.readFile(path.join(root, "Action-note.md"), "utf8")).toContain("context-tag");
  expect(await fs.readFile(path.join(root, "README.md"), "utf8")).toBe(originalNote);
});
test("paints the PDF page inside the file panel", async () => {
  const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium" });
  try {
    const context = await browser.newContext(),
      page = await context.newPage(),
      blank = await context.newPage();
    await blank.setContent("<style>@page{size:400px 400px;margin:0}body{background:rgb(11,237,83)}</style>");
    await fs.writeFile(
      path.join(root, "color.pdf"),
      largePdf(await blank.pdf({ preferCSSPageSize: true, printBackground: true })),
    );
    await page.bringToFront();
    await openFixture(page, "Preview.md", "# Preview\n");
    await page.getByRole("button", { name: "color.pdf", exact: true }).click();
    const frame = page.locator("#panel-body iframe");
    await expect(frame).toBeVisible();
    await expect
      .poll(async () => {
        const png = await frame.screenshot();
        return blank.evaluate(async (image) => {
          const img = new Image();
          img.src = `data:image/png;base64,${image}`;
          await img.decode();
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 64;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, 64, 64);
          const data = ctx.getImageData(0, 0, 64, 64).data;
          let green = 0;
          for (let i = 0; i < data.length; i += 4) if (data[i] < 35 && data[i + 1] > 210 && data[i + 2] < 110) green++;
          return green;
        }, png.toString("base64"));
      })
      .toBeGreaterThan(50);
  } finally {
    await browser.close();
  }
});

test("switching projects from a dirty source file keeps or discards the right draft", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { participants: 1, source: true });
  try {
    const [page] = library.pages;
    const file = path.join(library.notes, "draft.ts");
    await fs.writeFile(file, "const before = true;\n");
    const res = await page.request.post(new URL("/api/projects", library.url).href, {
      data: { action: "create", name: "Destination", kind: "new" },
    });
    expect(res.ok(), await res.text()).toBe(true);
    const target = (await res.json()).id;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.getByRole("button", { name: "draft.ts", exact: true }).click();
    await page.getByRole("textbox", { name: "Source code" }).fill("unsaved");
    await page.locator("#projects-open").click();
    const choose = page.locator(`.project-open[data-project="${target}"]`);
    await choose.click();
    await confirmDialog(page, { accept: false });
    await page.locator("#projects-close").click();
    await expect(page.locator("#workspace-file-panel")).toBeVisible();
    await expect(page.locator("#panel-status")).toHaveText("Unsaved changes");
    await page.locator("#projects-open").click();
    await choose.click();
    await confirmDialog(page);
    await expect(page.locator("#workspace-file-panel")).toBeHidden();
    await expect(page.locator("#projects-open")).toHaveText("Destination");
    expect(await fs.readFile(file, "utf8")).toBe("const before = true;\n");
  } finally {
    await library.close();
  }
});
