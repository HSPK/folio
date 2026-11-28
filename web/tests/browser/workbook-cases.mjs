import { chromium } from "@playwright/test";
import { test, expect, fs, path, root, confirmDialog, openFixture, openMoreAction, userResourceId } from "./fixture.mjs";
import { collaborativeLibrary } from "./collaboration-cases.mjs";

import { workbook, largePdf } from "./panel-fixture.mjs";

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

