import { crc32 } from "node:zlib";
import { chromium } from "@playwright/test";
import { test, expect, fs, path, root, confirmDialog, openFixture, openMoreAction, userResourceId } from "./fixture.mjs";
import { collaborativeLibrary } from "./collaboration-cases.mjs";

// A real, uncompressed two-sheet OOXML fixture without a runtime Excel dependency.
function workbook(total = 105, groups = 0) {
  const ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const relationships = (body) =>
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`;
  const relationship = (id, type, target) => `<Relationship Id="${id}" Type="${rel}/${type}" Target="${target}"/>`;
  const parts = {
    "[Content_Types].xml":
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
    "_rels/.rels": relationships(relationship("id1", "officeDocument", "xl/workbook.xml")),
    "xl/workbook.xml": `<workbook xmlns="${ns}" xmlns:r="${rel}"><sheets><sheet name="North" sheetId="1" r:id="id1"/><sheet name="South" sheetId="2" r:id="id2"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": relationships(
      [1, 2].map((i) => relationship(`id${i}`, "worksheet", `worksheets/sheet${i}.xml`)).join(""),
    ),
  };
  for (const i of [1, 2]) {
    const inline = (ref, text) => `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;
    const records = Array.from({ length: total }, (_, n) => {
      const row = n + 2;
      return `<row r="${row}"${n === total - 1 ? ' ht="36" customHeight="1"' : ""}>${inline(`A${row}`, n === total - 1 ? "Beyond page" : n === 0 ? `Region ${i}` : `Item ${groups ? n % groups : n}`)}<c r="B${row}"><v>${total - n}</v></c></row>`;
    }).join("");
    parts[`xl/worksheets/sheet${i}.xml`] =
      `<worksheet xmlns="${ns}"><sheetFormatPr defaultRowHeight="21" defaultColWidth="16"/><cols><col min="1" max="1" width="28" customWidth="1"/></cols><sheetData><row r="1">${inline("A1", "Region")}${inline("B1", "Count")}</row>${records}</sheetData></worksheet>`;
  }
  const data = [],
    central = [];
  let offset = 0;
  for (const [filename, text] of Object.entries(parts)) {
    const name = Buffer.from(filename),
      bytes = Buffer.from(text),
      h = Buffer.alloc(30),
      c = Buffer.alloc(46);
    h.writeUInt32LE(0x04034b50);
    h.writeUInt16LE(20, 4);
    h.writeUInt32LE(crc32(bytes), 14);
    h.writeUInt32LE(bytes.length, 18);
    h.writeUInt32LE(bytes.length, 22);
    h.writeUInt16LE(name.length, 26);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(20, 4);
    h.copy(c, 6, 4, 30);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    data.push(h, name, bytes);
    offset += h.length + name.length + bytes.length;
  }
  const end = Buffer.alloc(22),
    index = Buffer.concat(central);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(data.length / 3, 8);
  end.writeUInt16LE(data.length / 3, 10);
  end.writeUInt32LE(index.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...data, index, end]);
}

function largePdf(bytes) {
  const xref = bytes.toString("latin1").match(/startxref\s+(\d+)\s+%%EOF\s*$/)?.[1];
  if (!xref) throw new Error("Missing PDF cross-reference.");
  return Buffer.concat([bytes, Buffer.from("\n%"), Buffer.alloc(17 << 20, 32),
    Buffer.from(`\nstartxref\n${xref}\n%%EOF\n`)]);
}

test("project switches discard the previous file link instead of failing to connect", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { participants: 1 });
  try {
    const [page] = library.pages;
    await fs.writeFile(path.join(library.notes, "Previous.xlsx"), workbook());
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.getByRole("button", { name: "Previous.xlsx", exact: true }).click();
    await expect(page.getByRole("cell", { name: "Region 1" })).toBeVisible();
    await expect(page).toHaveURL(/asset=/);
    const previousFile = new URL(page.url()).searchParams.get("asset");
    const response = await page.request.post(new URL("/api/projects", library.url).href, {
      data: { action: "create", name: "Empty destination", kind: "new" },
    });
    expect(response.ok()).toBe(true);
    const project = await response.json();
    await page.locator("#projects-open").click();
    await page.locator(`.project-open[data-project="${project.id}"]`).click();
    await expect(page.locator("#tree-message")).toHaveText("No notes yet");
    expect(new URL(page.url()).searchParams.has("asset")).toBe(false);
    await expect(page.locator("#connection-message")).toBeHidden();
    await page.reload();
    await expect(page.locator("#tree-message")).toHaveText("No notes yet");
    await expect(page.locator("#connection-message")).toBeHidden();
    const stale = new URL("/", library.url);
    stale.searchParams.set("project", project.id);
    stale.searchParams.set("asset", previousFile);
    await page.goto(stale.href);
    await expect(page.locator("#document-message")).toContainText("Cannot open file");
    await expect(page.locator("#connection-message")).toBeHidden();
    await expect(page.locator("#tree-message")).toHaveText("No notes yet");
    expect(new URL(page.url()).searchParams.has("asset")).toBe(false);
  } finally { await library.close(); }
});

test("fresh file links select their project after login and folders only open when requested", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { participants: 1 });
  const guest = await browser.newContext();
  try {
    const [owner] = library.pages;
    const response = await owner.request.post(new URL("/api/projects", library.url).href, {
      data: { action: "create", name: "File project", kind: "new" },
    });
    expect(response.ok()).toBe(true);
    const project = await response.json();
    await fs.writeFile(path.join(project.root, "Resume.xlsx"), workbook());
    for (let i = 0; i < 8; i++) {
      await fs.mkdir(path.join(project.root, `Group ${i}`, "Inner"), { recursive: true });
      await fs.writeFile(path.join(project.root, `Group ${i}`, "Inner", `Deep ${i}.md`), `# Deep ${i}\n`);
    }
    const id = await userResourceId(owner.context(), library.url, "Resume.xlsx", "asset", project.id);
    const url = new URL("/", library.url);
    url.searchParams.set("asset", id);
    const page = await guest.newPage();
    await page.route("**/api/projects", async route => {
      const response = await route.fetch();
      const projects = await response.json();
      projects.sort((a, b) => Number(b.id === "default") - Number(a.id === "default"));
      await route.fulfill({ response, json: projects });
    });
    await page.goto(url.href);
    await page.locator("#auth-username").fill("alice");
    await page.locator("#auth-password").fill("alice test password long enough");
    await page.locator("#auth-submit").click();
    await expect(page.locator("#projects-open")).toHaveText("File project");
    await expect(page.getByRole("cell", { name: "Region 1" })).toBeVisible();
    await expect(page.locator("#connection-message")).toBeHidden();
    const folders = page.locator('details.directory[data-path^="Group "]');
    await expect(folders).toHaveCount(16);
    await expect(page.locator('details.directory[open]')).toHaveCount(0);
    const group = page.locator('details.directory[data-path="Group 0"]');
    const inner = page.locator('details.directory[data-path="Group 0/Inner"]');
    await group.locator(":scope > summary").click();
    await inner.locator(":scope > summary").click();
    await expect(page.locator("details.directory[open]")).toHaveCount(2);
    await page.reload();
    await expect(page.getByRole("cell", { name: "Region 1" })).toBeVisible();
    await expect(page.locator("details.directory[open]")).toHaveCount(2);
    await fs.mkdir(path.join(project.root, "New group"));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.locator('details.directory[data-path="New group"]')).toHaveJSProperty("open", false);
    await page.locator("#file-filter").fill("Deep 7");
    await expect(page.getByRole("button", { name: "Group 7/Inner/Deep 7.md", exact: true })).toBeVisible();
    await page.locator("#file-filter").fill("");
    await expect(page.locator("details.directory[open]")).toHaveCount(2);
  } finally { await guest.close(); await library.close(); }
});

test("an invalid file bookmark does not turn a healthy workspace into a connection failure", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { participants: 1 });
  try {
    const [page] = library.pages;
    const document = await userResourceId(page.context(), library.url, "Shared.md");
    const url = new URL("/", library.url);
    url.searchParams.set("project", "default");
    url.searchParams.set("asset", document);
    const missing = new URL("/", library.url);
    missing.searchParams.set("asset", "00000000-0000-7000-8000-000000000000");
    for (const target of [url, missing]) {
      await page.goto(target.href);
      await expect(page.getByRole("button", { name: "Shared.md", exact: true })).toBeVisible();
      await expect(page.locator("#document-message")).toContainText("file", { ignoreCase: true });
      await expect(page.locator("#connection-message")).toBeHidden();
      await expect(page.locator("#connection-label")).toHaveAttribute("data-state", "ready");
      await page.getByRole("button", { name: "Shared.md", exact: true }).click();
      await expect(page.locator(".ProseMirror[contenteditable=true]")).toBeVisible();
      await expect(page.locator("#connection-message")).toBeHidden();
    }
  } finally { await library.close(); }
});

test("Excel selection survives refresh during loading and restores before a slow file tree", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { participants: 1 });
  let release, releaseTree;
  const gate = new Promise(resolve => { release = resolve; });
  const treeGate = new Promise(resolve => { releaseTree = resolve; });
  try {
    const [page] = library.pages;
    await fs.writeFile(path.join(library.notes, "Remember.xlsx"), workbook());
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("button", { name: "Remember.xlsx", exact: true })).toBeVisible();
    let blocked = true;
    await page.route("**/api/resources/resolve", async route => {
      if (blocked && route.request().postDataJSON()?.path === "Remember.xlsx") await gate;
      await route.continue().catch(() => {});
    });
    await page.route("**/api/panel-file?*", async route => {
      if (blocked && new URL(route.request().url()).searchParams.get("path") === "Remember.xlsx") await gate;
      await route.continue().catch(() => {});
    });
    await page.getByRole("button", { name: "Remember.xlsx", exact: true }).click();
    await expect(page.locator("#panel-title")).toHaveText("Remember.xlsx");
    expect(new URL(page.url()).searchParams.has("document")).toBe(false);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("#panel-title")).toHaveText("Remember.xlsx");
    await expect(page.locator("#document-panes")).toBeHidden();
    blocked = false;
    release();
    await expect(page.getByRole("cell", { name: "Region 1" })).toBeVisible();
    await expect(page).toHaveURL(/asset=[a-f0-9-]+/);
    await page.route("**/api/tree*", async route => {
      await treeGate;
      await route.continue().catch(() => {});
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("cell", { name: "Region 1" })).toBeVisible();
    await expect(page.locator("#document-panes")).toBeHidden();
    releaseTree();
    await page.goto(library.url);
    await expect(page.locator("#panel-title")).toHaveText("Remember.xlsx");
    await expect(page.getByRole("cell", { name: "Region 1" })).toBeVisible();
  } finally { release(); releaseTree(); await library.close(); }
});

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

test("launch-token workspaces also restore Excel instead of the previous Markdown note", async ({ page }) => {
  await fs.writeFile(path.join(root, "Resume.xlsx"), workbook());
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.getByRole("button", { name: "Resume.xlsx", exact: true }).click();
  await expect(page.getByRole("cell", { name: "Region 1" })).toBeVisible();
  await expect(page).toHaveURL(/asset=[a-f0-9-]+/);
  await page.reload();
  await expect(page.getByRole("cell", { name: "Region 1" })).toBeVisible();
  await expect(page.locator("#document-panes")).toBeHidden();
  await page.getByRole("button", { name: "README.md", exact: true }).click();
  await expect(page.locator("#document-panes")).toBeVisible();
  await page.reload();
  await expect(page.locator("#document-title")).toHaveText("README");
  await expect(page.locator("#workspace-file-panel")).toBeHidden();
});

test("large workbooks reuse parsing, virtualize filters, and immediately acknowledge latest-wins sorts", async ({ browser }) => {
  test.setTimeout(60_000);
  const library = await collaborativeLibrary(browser, { participants: 1 });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  try {
    const [page] = library.pages;
    const file = path.join(library.notes, "Large.xlsx");
    await fs.writeFile(file, workbook(20_000, 1000));
    const endpoint = new URL("/api/panel-file?path=Large.xlsx&view=table", library.url).href;
    const options = { headers: { "X-Folio-Project": "default" } };
    const read = async (suffix, runs = 1) => {
      const times = [];
      let data;
      for (let i = 0; i < runs; i++) {
        const start = performance.now(), response = await page.request.get(endpoint + suffix, options);
        expect(response.ok(), await response.text()).toBe(true);
        data = await response.json();
        times.push(performance.now() - start);
      }
      return { data, ms: times.sort((a, b) => a - b)[Math.floor(times.length / 2)] };
    };
    const cold = await read("");
    const warm = await read("&sortCol=1", 5);
    expect(cold.data.height).toBe(20_000);
    expect(warm.data.rowNumbers[0]).toBe(20_001);
    const requests = [];
    page.on("request", request => {
      const url = new URL(request.url());
      if (url.pathname === "/api/panel-file" && url.searchParams.get("view") === "values") requests.push(url);
    });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.getByRole("button", { name: "Large.xlsx", exact: true }).click();
    await expect(page.getByRole("cell", { name: "Region 1" })).toBeVisible();
    const panel = page.locator("#workspace-file-panel");
    await panel.getByRole("button", { name: "Region", exact: true }).click();
    const menu = page.getByRole("dialog", { name: "Region filter and sort" });
    await expect(menu.locator(".sheet-filter-all small")).toHaveText("1002 / 1002");
    expect(await menu.locator(".sheet-filter-values label").count()).toBeLessThan(24);
    await menu.getByRole("searchbox").press("ArrowDown");
    await page.keyboard.press("End");
    await expect(menu.locator(".sheet-filter-values input:focus")).toHaveAttribute("data-index", "1001");
    await page.keyboard.press("Space");
    await expect(menu.locator(".sheet-filter-all small")).toHaveText("1001 / 1002");
    await menu.getByRole("searchbox").fill("item 999");
    await expect(menu.locator(".sheet-filter-values label")).toHaveCount(1);
    await menu.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.route("**/api/panel-file?*", async route => {
      const query = new URL(route.request().url()).searchParams;
      if (query.get("sortCol") === "0" && query.get("desc") === "false") await gate;
      await route.continue().catch(() => {});
    });
    await panel.getByRole("button", { name: "Region", exact: true }).click();
    await menu.getByRole("button", { name: "Ascending", exact: true }).click();
    await expect(panel.getByRole("status")).toHaveText("Sorting…");
    await expect(panel.locator("#panel-body")).toHaveAttribute("aria-busy", "true");
    await expect(panel.locator("tbody tr")).toHaveCount(100);
    await panel.getByRole("button", { name: "Region", exact: true }).click();
    await menu.getByRole("button", { name: "Descending", exact: true }).click();
    await expect(panel.locator("tbody tr").first()).toContainText("Region 1");
    await expect(panel.locator("#panel-body")).not.toHaveAttribute("aria-busy");
    release();
    expect(requests.length).toBeGreaterThan(0);
    for (const url of requests) {
      expect(url.searchParams.has("sortCol")).toBe(false);
      expect(url.searchParams.has("row")).toBe(false);
    }
    const filtered = await read("&filters=" + encodeURIComponent(JSON.stringify([{ col: 0, values: ["Item 999"] }])), 5);
    expect(filtered.data.height).toBe(19);
    await fs.writeFile(file, workbook(7));
    const changed = await read("");
    expect(changed.data.height).toBe(7);
    console.log(`20k-row workbook: cold ${cold.ms.toFixed(1)} ms; warm sort ${warm.ms.toFixed(1)} ms; warm filter ${filtered.ms.toFixed(1)} ms`);
  } finally { release(); await library.close(); }
});

test("file menus share read-only PDF, XLSX and code links without exposing the workspace", async ({ browser }) => {
  test.setTimeout(60_000);
  const library = await collaborativeLibrary(browser, { participants: 1, sharing: "private" });
  const guestBrowser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium" });
  const guest = await guestBrowser.newContext();
  try {
    const [owner] = library.pages;
    const pdf = await owner.pdf(), book = workbook();
    const fixtures = [
      ["Report.xlsx", book],
      ["Report.pdf", pdf],
      ["example.py", Buffer.from("print(42)\n")],
    ];
    for (const [name, bytes] of fixtures) await fs.writeFile(path.join(library.notes, name), bytes);
    await owner.evaluate(() => window.dispatchEvent(new Event("focus")));
    const menu = owner.getByRole("menu", { name: "File actions" });
    const row = name => owner.locator(`[data-entry-path="${name}"]`);
    const errors = [];
    const page = await guest.newPage();
    page.on("pageerror", error => errors.push(error.message));
    const unexpected = [];
    page.on("request", request => {
      if (/^\/api\/(?:public\/)?(?:tree|workspace|auth\/status|preferences|projects|appearance|document)\b/.test(new URL(request.url()).pathname))
        unexpected.push(request.url());
    });
    await owner.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
        writeText: async text => { window.copiedLink = text; },
      } });
    });
    for (const [name, bytes] of fixtures) {
      await row(name).click();
      await expect(owner.locator("#panel-title")).toHaveText(name);
      await owner.locator("#panel-more").click();
      await owner.locator("#panel-more").click();
      await expect(menu).toBeHidden();
      await owner.locator("#panel-more").click();
      await expect(menu.getByRole("menuitem", { name: "Share file", exact: true })).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: "Copy link", exact: true })).toBeVisible();
      await menu.getByRole("menuitem", { name: "Copy link", exact: true }).click();
      await expect.poll(() => owner.evaluate(() => window.copiedLink)).toMatch(/asset=[a-f0-9-]+/);
      const internal = await owner.evaluate(() => window.copiedLink);
      const other = await owner.context().newPage();
      await other.goto(internal);
      await expect(other.locator("#panel-title")).toHaveText(name);
      await expect(other.locator("#workspace-file-panel")).toBeVisible();
      await other.close();
      await row(name).click({ button: "right" });
      await menu.getByRole("menuitem", { name: "Favorite", exact: true }).click();
      await expect.poll(async () => {
        const response = await owner.request.get(new URL("/api/workspace", library.url).href);
        return (await response.json()).workspace.favorites.some(file => file.path === name);
      }).toBe(true);
      await owner.locator("#panel-more").click();
      await expect(menu.getByRole("menuitem", { name: "Unfavorite", exact: true })).toBeVisible();
      await expect(menu.locator("button:visible:not(:has(.menu-icon))")).toHaveCount(0);
      if (name.endsWith(".xlsx")) await owner.screenshot({ path: test.info().outputPath("file-actions.png") });
      await menu.getByRole("menuitem", { name: "Edit tags", exact: true }).click();
      await expect(owner.locator("#file-property-tags")).toBeFocused();
      await owner.locator("#file-property-tags").fill("shared, test");
      await owner.locator("#file-properties-save").click();
      await owner.locator("#panel-more").click();
      await menu.getByRole("menuitem", { name: "Share file", exact: true }).click();
      await expect(owner.locator("#sharing-title")).toHaveText("File permissions");
      await owner.locator("#sharing-level").selectOption("publicRead");
      await expect(owner.locator("#sharing-public-edit")).toBeHidden();
      await owner.locator("#sharing-save").click();
      await expect(owner.locator("#sharing-public-url")).toHaveValue(/\/s\/[A-Za-z0-9_-]{8}$/);
      const url = await owner.locator("#sharing-public-url").inputValue(), share = new URL(url).pathname.slice(3);
      await page.goto(url);
      await expect(page.locator("#panel-title")).toHaveText(name);
      await expect(page.locator("#auth-screen")).toBeHidden();
      await expect(page.locator("#sidebar")).toBeHidden();
      await expect(page.locator("#document-panes")).toBeHidden();
      if (name.endsWith(".xlsx")) {
        await expect(page.getByRole("cell", { name: "Region 1" })).toBeVisible();
        await page.getByRole("tab", { name: "South", exact: true }).click();
        await expect(page.getByRole("cell", { name: "Region 2" })).toBeVisible();
      } else if (name.endsWith(".pdf")) await expect(page.locator("#panel-body iframe")).toHaveAttribute("src", /^\/api\/public\/panel-file\?/);
      else {
        await expect(page.locator(".folio-code-source .cm-content")).toContainText("print(42)");
        await expect(page.locator(".folio-code-source .cm-content")).toHaveAttribute("contenteditable", "false");
        await expect(page.locator("#panel-tools button")).toHaveCount(0);
      }
      await page.locator("#panel-more").click();
      const publicMenu = page.getByRole("menu", { name: "File actions" });
      await expect(publicMenu.getByRole("menuitem")).toHaveCount(3);
      await expect(publicMenu.getByRole("menuitem", { name: "Download", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator("#panel-more")).toBeFocused();
      const headers = { "X-Folio-Share": share };
      const download = await guest.request.get(new URL(`/api/public/panel-file?${new URLSearchParams({ path: name, download: "true" })}`, url).href, { headers });
      expect(download.ok(), await download.text()).toBe(true);
      expect(await download.body()).toEqual(bytes);
      for (const forbidden of ["Other.md", ...fixtures.map(([file]) => file).filter(file => file !== name)]) {
        const denied = await guest.request.get(new URL(`/api/public/panel-file?${new URLSearchParams({ path: forbidden })}`, url).href, { headers });
        expect(denied.ok(), forbidden).toBe(false);
      }
      expect((await guest.request.get(new URL("/api/tree", url).href, { headers })).status()).toBe(401);
      expect((await guest.request.put(new URL("/api/public/panel-file", url).href, { headers, data: { path: name, content: "hacked", version: "0" } })).ok()).toBe(false);
      expect((await guest.request.post(new URL("/api/public/collaboration/join", url).href, { headers, data: { document: new URL(internal).searchParams.get("asset") } })).ok()).toBe(false);
      await page.reload();
      await expect(page.locator("#panel-title")).toHaveText(name);
      await expect(page.locator("#panel-status")).not.toContainText(/error|failed|unavailable/i);
      await owner.locator("#sharing-cancel").click();
      expect(await fs.readFile(path.join(library.notes, name))).toEqual(bytes);
    }
    await row("Shared.md").click();
    await openMoreAction(owner, "workspace-open");
    await owner.locator("#workspace-kind").selectOption("favorites");
    await owner.locator("#workspace-list .workspace-item-name").filter({ hasText: "Report.xlsx" }).click();
    await expect(owner.getByRole("cell", { name: "Region 1" })).toBeVisible();
    await expect.poll(() => owner.url()).toContain("asset=");
    await owner.reload();
    await expect(owner.locator("#panel-title")).toHaveText("Report.xlsx");
    await expect(owner.getByRole("cell", { name: "Region 1" })).toBeVisible();
    await owner.goto(library.url);
    await expect(owner.locator("#panel-title")).toHaveText("Report.xlsx");
    await expect(owner.getByRole("cell", { name: "Region 1" })).toBeVisible();
    expect(unexpected).toEqual([]);
    expect(errors).toEqual([]);
  } finally { await guestBrowser.close(); await library.close(); }
});

for (const extension of ["xlsx", "pdf"]) test(`file sharing honors passwords, identity moves, expiration, reset and revocation (${extension})`, async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { participants: 1, sharing: "private" });
  const guest = await browser.newContext();
  try {
    const [owner] = library.pages;
    const name = `Protected.${extension}`, renamed = `Renamed.${extension}`;
    await fs.writeFile(path.join(library.notes, name), extension === "pdf" ? await owner.pdf() : workbook());
    const identity = await owner.request.post(new URL("/api/resources/resolve", library.url).href, {
      data: { path: name, kind: "asset" }, headers: { "X-Folio-Project": "default" },
    });
    expect(identity.ok(), await identity.text()).toBe(true);
    const { id } = await identity.json();
    const change = data => owner.request.post(new URL("/api/projects", library.url).href, { data: { id: "default", document: id, ...data } });
    const shared = await change({ action: "document", permission: "publicRead", publicOptions: { password: "file share password" } });
    expect(shared.ok(), await shared.text()).toBe(true);
    let token = (await shared.json()).publicLinks[name].token;
    const url = new URL(`/s/${token}`, library.url).href, page = await guest.newPage();
    const endpoint = filename => new URL(`/api/public/panel-file?${new URLSearchParams({ path: filename,
      view: extension === "pdf" ? "pdf" : "table", share: token })}`, library.url).href;
    const read = filename => guest.request.get(endpoint(filename), { headers: extension === "pdf" ? { Range: "bytes=0-4" } : {} });
    const preview = async () => {
      if (extension === "pdf") await expect(page.getByRole("link", { name: "Download PDF" })).toBeVisible();
      else await expect(page.getByRole("cell", { name: "Region 1" })).toBeVisible();
    };
    expect((await read(name)).status()).toBe(401);
    await page.goto(url);
    await expect(page.locator("#public-password-dialog")).toBeVisible();
    await expect(page.locator("#workspace-file-panel")).toBeHidden();
    await page.locator("#public-password").fill("incorrect");
    await page.locator("#public-password-submit").click();
    await expect(page.locator("#public-password-error")).toContainText("incorrect");
    await page.locator("#public-password").fill("file share password");
    await page.locator("#public-password-submit").click();
    await preview();
    expect((await read(name)).ok()).toBe(true);
    if (extension === "pdf") expect(await (await read(name)).body()).toEqual(Buffer.from("%PDF-"));
    const move = await owner.request.patch(new URL("/api/entry", library.url).href, {
      headers: { "X-Folio-Project": "default" }, data: { id, destination: renamed },
    });
    expect(move.ok(), await move.text()).toBe(true);
    await page.reload();
    await expect(page.locator("#panel-title")).toHaveText(renamed);
    await preview();
    expect((await read(name)).ok()).toBe(false);
    expect((await read(renamed)).ok()).toBe(true);
    const reset = await change({ action: "document", permission: "publicRead", resetLink: true, publicOptions: { clearPassword: true } });
    expect(reset.ok(), await reset.text()).toBe(true);
    expect((await read(renamed)).ok()).toBe(false);
    token = (await reset.json()).publicLinks[renamed].token;
    const session = await guest.request.post(new URL("/api/public/session", library.url).href, { headers: { "X-Folio-Share": token } });
    expect((await session.json()).passwordRequired).not.toBe(true);
    expect((await read(renamed)).ok()).toBe(true);
    const expired = await change({ action: "publicOptions", expiresAt: Date.now() + 1500 });
    expect(expired.ok(), await expired.text()).toBe(true);
    await expect.poll(async () => (await read(renamed)).ok()).toBe(false);
    const renew = await change({ action: "publicOptions", expiresAt: null });
    expect(renew.ok(), await renew.text()).toBe(true);
    expect((await read(renamed)).ok()).toBe(true);
    const revoke = await change({ action: "revokePublic" });
    expect(revoke.ok(), await revoke.text()).toBe(true);
    expect((await read(renamed)).ok()).toBe(false);
    expect((await change({ action: "document", permission: "publicEdit" })).status()).toBe(400);
    expect((await change({ action: "document", permission: "edit" })).status()).toBe(400);
  } finally { await guest.close(); await library.close(); }
});

test("individual file permissions and favorites work without project-wide access", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { participants: 1, sharing: "private" });
  try {
    const [owner] = library.pages, reader = library.contexts[1];
    for (const [name, content] of [["visible.py", "print(1)\n"], ["hidden.py", "secret\n"]])
      await fs.writeFile(path.join(library.notes, name), content);
    await fs.writeFile(path.join(library.notes, "visible.xlsx"), workbook());
    const request = (name, context = reader) => context.request.get(new URL(`/api/panel-file?path=${name}`, library.url).href, {
      headers: { "X-Folio-Project": "default" },
    });
    const identify = async name => {
      const response = await owner.request.post(new URL("/api/resources/resolve", library.url).href, {
        headers: { "X-Folio-Project": "default" }, data: { path: name, kind: "asset" },
      });
      expect(response.ok(), await response.text()).toBe(true);
      return (await response.json()).id;
    };
    const id = await identify("visible.py"), book = await identify("visible.xlsx");
    const permission = async (document, value) => {
      const response = await owner.request.post(new URL("/api/projects", library.url).href, {
        data: { action: "document", id: "default", document, permission: value },
      });
      expect(response.ok(), await response.text()).toBe(true);
    };
    expect((await request("visible.py")).ok()).toBe(false);
    await permission(id, "read");
    await permission(book, "read");
    const file = await request("visible.py");
    expect(file.ok(), await file.text()).toBe(true);
    expect((await file.json()).writable).toBe(false);
    expect((await request("visible.xlsx")).ok()).toBe(true);
    expect((await request("hidden.py")).ok()).toBe(false);
    const tree = await reader.request.get(new URL("/api/tree", library.url).href, { headers: { "X-Folio-Project": "default" } });
    expect((await tree.json()).panelFiles.sort()).toEqual(["visible.py", "visible.xlsx"]);
    const favorite = await reader.request.post(new URL("/api/workspace", library.url).href, {
      data: { action: "favorite", project: "default", id, value: true },
    });
    expect(favorite.ok(), await favorite.text()).toBe(true);
    expect((await favorite.json()).workspace.favorites).toEqual([expect.objectContaining({ id, path: "visible.py" })]);
    const page = await reader.newPage();
    await page.goto(new URL(`/?project=default&asset=${id}`, library.url).href);
    await expect(page.locator(".folio-code-source .cm-content")).toHaveText("print(1)");
    await page.locator("#panel-more").click();
    const menu = page.getByRole("menu", { name: "File actions" });
    await expect(menu.getByRole("menuitem", { name: "Share file", exact: true })).toHaveCount(0);
    await expect(menu.getByRole("menuitem", { name: "Unfavorite", exact: true })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Edit tags", exact: true })).toHaveCount(0);
    const denied = await reader.request.post(new URL("/api/projects", library.url).href, {
      data: { action: "document", id: "default", document: id, permission: "publicRead" },
    });
    expect(denied.status()).toBe(403);
    await permission(id, "edit");
    const fresh = await request("visible.py");
    const code = await fresh.json();
    expect(code.writable).toBe(true);
    const edited = await reader.request.put(new URL("/api/panel-file", library.url).href, {
      headers: { "X-Folio-Project": "default" }, data: { path: "visible.py", content: "print(2)\n", version: code.version },
    });
    expect(edited.ok(), await edited.text()).toBe(true);
    await permission(id, "private");
    expect((await request("visible.py")).status()).toBe(403);
    const removed = await reader.request.post(new URL("/api/workspace", library.url).href, {
      data: { action: "favorite", project: "default", id, value: false },
    });
    expect(removed.ok(), await removed.text()).toBe(true);
    await permission(book, "private");
    expect((await request("visible.xlsx")).ok()).toBe(false);
  } finally { await library.close(); }
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
test("opening and switching workbooks leaves the previous Markdown folder collapsed", async ({ page }) => {
  await fs.mkdir(path.join(root, "mds"));
  await fs.writeFile(path.join(root, "mds", "inside.md"), "# Inside\n");
  const file = workbook();
  for (const name of ["First.xlsx", "Second.xlsx"]) await fs.writeFile(path.join(root, name), file);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.locator('summary[data-entry-path="mds"]').click();
  await page.locator('[data-path="mds/inside.md"]').click();
  await expect(page.locator("#document-title")).toHaveText(/inside/i);
  const dir = page.locator('details.directory[data-path="mds"]');
  await dir.locator(":scope > summary").click();
  await expect(dir).toHaveJSProperty("open", false);
  for (const name of ["First.xlsx", "Second.xlsx"]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.getByRole("cell", { name: "Region 1" })).toBeVisible();
    await expect(dir).toHaveJSProperty("open", false);
  }
  const panel = page.locator("#workspace-file-panel");
  const tabs = panel.getByRole("tablist");
  const surface = panel.locator(".file-panel-surface");
  const bounds = await surface.boundingBox();
  expect((await tabs.boundingBox()).y).toBeGreaterThan(bounds.y + bounds.height);
  await tabs.getByRole("tab", { name: "North" }).press("ArrowRight");
  await expect(panel.getByRole("cell", { name: "Region 2" })).toBeVisible();
  await expect(panel.getByRole("status")).toBeHidden();
  await expect(dir).toHaveJSProperty("open", false);
});

test("workbook headers sort and filter across pages without modifying the workbook", async ({ page }) => {
  const file = path.join(root, "rows.xlsx"),
    bytes = workbook();
  await fs.writeFile(file, bytes);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const originalSidebar = await page.locator("#sidebar").boundingBox();
  await page.getByRole("button", { name: "rows.xlsx", exact: true }).click();
  const panel = page.locator("#workspace-file-panel"),
    surface = panel.locator(".file-panel-surface");
  const count = panel.getByRole("button", { name: "Count", exact: true });
  await expect(count).toBeVisible();
  const sidebar = await page.locator("#sidebar").boundingBox(),
    box = await panel.boundingBox();
  expect(Math.abs(box.y - sidebar.y)).toBeLessThan(1);
  expect(Math.abs(box.height - sidebar.height)).toBeLessThan(1);
  expect(sidebar.height).toBe(originalSidebar.height);
  const tabsBox = await panel.getByRole("tablist").boundingBox();
  expect(tabsBox.y + tabsBox.height).toBeLessThanOrEqual(sidebar.y + sidebar.height + 1);
  await expect.poll(async () => {
    const box = await surface.boundingBox(), sidebar = await page.locator("#sidebar").boundingBox();
    return box.x - sidebar.x - sidebar.width;
  }).toBeLessThanOrEqual(8);
  await expect(panel.getByRole("button", { name: "Close file panel" })).toHaveCount(0);
  await count.click();
  const menu = page.getByRole("dialog", { name: "Count filter and sort" });
  await expect(count).toHaveCSS("border-radius", "0px");
  await menu.getByRole("button", { name: "Ascending", exact: true }).click();
  const first = panel.locator("tbody tr").first();
  await expect(first.getByRole("cell").first()).toHaveText("Beyond page");
  await expect(first.getByRole("rowheader")).toHaveText("106");
  expect((await first.boundingBox()).height).toBeCloseTo(49, 0);
  expect((await first.getByRole("cell").first().boundingBox()).width).toBeCloseTo(201, 0);
  await count.click();
  await menu.getByRole("button", { name: "Descending", exact: true }).click();
  await expect(first.getByRole("cell").first()).toHaveText("Region 1");
  await panel.getByRole("button", { name: "Region", exact: true }).click();
  const region = page.getByRole("dialog", { name: "Region filter and sort" });
  await region.getByRole("searchbox").fill("BEYOND");
  await expect(region.locator(".sheet-filter-values label")).toHaveCount(1);
  await page.screenshot({ path: test.info().outputPath("column-filter.png"), animations: "disabled" });
  await region.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(panel.locator("tbody tr")).toHaveCount(1);
  await expect(first).toContainText("Beyond page");
  const handle = panel.getByRole("separator", { name: "Resize column A", exact: true });
  const before = await first.getByRole("cell").first().boundingBox(),
    pos = await handle.boundingBox();
  await page.mouse.move(pos.x + 3, pos.y + 8);
  await page.mouse.down();
  await page.mouse.move(pos.x + 53, pos.y + 8);
  await page.mouse.up();
  expect((await first.getByRole("cell").first().boundingBox()).width).toBeGreaterThan(before.width + 40);
  const height = await first.boundingBox();
  await panel.getByRole("separator", { name: "Resize row 106", exact: true }).press("ArrowDown");
  expect((await first.boundingBox()).height).toBeGreaterThan(height.height);
  await panel.getByRole("tab", { name: "South" }).click();
  await expect(first.getByRole("cell").first()).toHaveText("Region 2");
  await panel.getByRole("tab", { name: "North" }).click();
  await expect(first.getByRole("cell").first()).toHaveText("Beyond page");
  await panel.getByRole("button", { name: "Region", exact: true }).click();
  await expect.poll(() => region.locator(".sheet-filter-values label").count()).toBeGreaterThan(0);
  expect(await region.locator(".sheet-filter-values label").count()).toBeLessThan(24);
  await region.getByRole("checkbox", { name: "Select all", exact: true }).check();
  await region.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(panel.locator("tbody tr")).toHaveCount(1);
  await panel.getByRole("button", { name: "Region", exact: true }).click();
  await region.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(panel.locator("tbody tr")).toHaveCount(100);
  expect(await fs.readFile(file)).toEqual(bytes);
});

test("workbook sparse page offsets retain fallback sizes and manual overrides", async ({ page }) => {
  await fs.writeFile(path.join(root, "Paging.xlsx"), workbook());
  const text = "A long wrapped worksheet value ".repeat(6) + "\nSecond line";
  await page.route("**/api/panel-file?*", async route => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get("path") !== "Paging.xlsx" || query.get("view") !== "table") return route.continue();
    const row = Number(query.get("row")), col = Number(query.get("col"));
    await route.fulfill({ json: {
      sheets: ["North"], row, col, rows: 100, cols: 32, height: 102, width: 34,
      headers: Array.from({ length: Math.min(32, 34 - col) }, (_, i) => `Column ${col + i + 1}`),
      rowNumbers: Array.from({ length: Math.min(100, 102 - row) }, (_, i) => row + i + 2),
      cells: col === 32 ? [[row, 32, text], [row + 1, 33, "Tail"]]
        : [[row, 0, row ? "Row page" : "First page"]],
      layout: { columnWidths: [], rowHeights: [] },
    } });
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.getByRole("button", { name: "Paging.xlsx", exact: true }).click();
  const panel = page.locator("#workspace-file-panel");
  await expect(panel.getByRole("cell", { name: "First page", exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Next rows" }).click();
  await expect(panel.getByRole("cell", { name: "Row page", exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Next columns" }).click();
  const rows = panel.locator("tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.first().locator("td").nth(0)).toHaveText(text);
  await expect(rows.first().locator("td").nth(1)).toBeEmpty();
  await expect(rows.last().locator("td").nth(0)).toBeEmpty();
  await expect(rows.last().locator("td").nth(1)).toHaveText("Tail");
  const column = panel.locator("colgroup col").nth(1);
  const width = await column.evaluate(node => parseFloat(node.style.width));
  expect(width).toBeGreaterThanOrEqual(104);
  expect(width).toBeLessThanOrEqual(320);
  const height = await rows.first().evaluate(node => parseFloat(node.style.getPropertyValue("--sheet-row-height")));
  expect(height).toBeGreaterThan(28);
  await panel.getByRole("separator", { name: "Resize column AG", exact: true }).press("ArrowRight");
  await panel.getByRole("separator", { name: "Resize row 102", exact: true }).press("ArrowDown");
  await panel.getByRole("button", { name: "Previous columns" }).click();
  await expect(panel.getByRole("cell", { name: "Row page", exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Next columns" }).click();
  await expect(rows.last().locator("td").nth(1)).toHaveText("Tail");
  expect(await column.evaluate(node => parseFloat(node.style.width))).toBe(width + 8);
  expect(await rows.first().evaluate(node => parseFloat(node.style.getPropertyValue("--sheet-row-height")))).toBe(height + 8);
});

test("project file panels enforce reader permissions on both UI and save", async ({ browser }) => {
  const lib = await collaborativeLibrary(browser, { source: true, participants: 1, sharing: "read" });
  const ctx = await browser.newContext();
  try {
    await fs.writeFile(path.join(lib.notes, "script.js"), "const value = 1;\n");
    const url = new URL("/api/panel-file?path=script.js", lib.url).href;
    expect((await ctx.request.get(url)).status()).toBe(401);
    const login = await ctx.request.post(new URL("/api/auth/login", lib.url).href, {
      data: { username: "bob", password: "bob test password long enough" },
    });
    expect(login.ok()).toBe(true);
    const p = await ctx.newPage();
    await p.goto(lib.pages[0].url());
    await p.getByRole("button", { name: "script.js", exact: true }).click();
    await expect(p.getByRole("textbox", { name: "Source code" })).not.toBeEditable();
    const options = { headers: { "X-Folio-Project": "default" } },
      file = await (await ctx.request.get(url, options)).json();
    const propertiesUrl = new URL("/api/file-properties?path=script.js", lib.url).href;
    const properties = await (await ctx.request.get(propertiesUrl, options)).json();
    expect(properties.writable).toBe(false);
    const propertyEdit = {
      path: "script.js", id: properties.entry.id, revision: properties.snapshot.revision,
      properties: { title: "Script", tags: ["code"], description: "" },
    };
    expect((await ctx.request.put(propertiesUrl, { ...options, data: propertyEdit })).status()).toBe(403);
    expect((await ctx.request.post(url, { ...options, data: { path: "script.js", destination: "copy.js" } })).status()).toBe(403);
    const put = await ctx.request.put(new URL("/api/panel-file", lib.url).href, {
      ...options,
      data: { path: "script.js", version: file.version, content: "changed" },
    });
    expect(put.status()).toBe(403);
    expect(await fs.readFile(path.join(lib.notes, "script.js"), "utf8")).toContain("value = 1");
    const [owner] = lib.pages;
    const share = async (data) => {
      const result = await owner.request.post(new URL("/api/projects", lib.url).href, {
        data: { id: "default", ...data },
      });
      expect(result.ok(), await result.text()).toBe(true);
      return result.json();
    };
    await share({ action: "share", shared: "edit" });
    expect((await ctx.request.put(propertiesUrl, { ...options, data: propertyEdit })).ok()).toBe(true);
    expect((await ctx.request.put(propertiesUrl, { ...options, data: propertyEdit })).status()).toBe(409);
    const edited = await ctx.request.put(url, {
      ...options,
      data: { path: "script.js", version: file.version, content: "const value = 2;\n" },
    });
    expect(edited.ok(), await edited.text()).toBe(true);
    expect(await fs.readFile(path.join(lib.notes, "script.js"), "utf8")).toBe("const value = 2;\n");
    await fs.writeFile(path.join(lib.notes, "Only.md"), "[Attachment](script.js)\n");
    const id = (name) => userResourceId(owner.context(), lib.url, name);
    await share({ action: "document", document: await id("Only.md"), permission: "private" });
    const tree = async () =>
      (await (await ctx.request.get(new URL("/api/tree", lib.url).href, options)).json()).panelFiles ?? [];
    expect(await tree()).not.toContain("script.js");
    expect((await ctx.request.get(url, options)).status()).toBe(403);
    expect((await ctx.request.get(propertiesUrl, options)).status()).toBe(403);
    await fs.writeFile(path.join(lib.notes, "another.js"), "// Project only\n");
    await share({ action: "share", shared: "private" });
    const document = await id("Shared.md");
    await share({ action: "share", document, shared: "read" });
    expect(await tree()).toEqual([]);
    expect((await ctx.request.get(url.replace("script.js", "another.js"), options)).status()).toBe(403);
    const pub = await share({ action: "document", document, permission: "publicRead" });
    const guest = await browser.newContext();
    try {
      const headers = { "X-Folio-Share": pub.publicLinks["Shared.md"].token };
      expect((await guest.request.get(url, { headers })).status()).toBe(401);
      expect(
        (await guest.request.get(url.replace("/api/panel-file", "/api/public/panel-file"), { headers })).ok(),
      ).toBe(false);
    } finally {
      await guest.close();
    }
  } finally {
    await ctx.close();
    await lib.close();
  }
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
