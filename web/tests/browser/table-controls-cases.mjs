import { test, expect, fs, path, root, openFixture, chooseView, primaryModifier, openTableTools } from "./fixture.mjs";

const source = "| Name | State | Owner |\n| --- | --- | --- |\n| A | Draft | One |\n| B | Ready | Two |\n\nTail paragraph.\n";
const tools = page => page.getByRole("menu", { name: "Table actions", exact: true });

async function capture(page, name, browserName) {
  if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath(`${name}.png`), caret: "initial" });
}

for (const width of [1440, 390]) {
  test(`table header and edge regions remain distinct at ${width}px`, async ({ page, browserName }) => {
    await page.setViewportSize({ width, height: 844 });
    await openFixture(page, `Table-regions-${width}.md`, source);
    const table = page.locator(".folio-table-wrapper");
    const row = table.locator(".folio-table-add-row");
    const column = table.locator(".folio-table-add-column");
    const whole = page.locator(".folio-block-grip");
    await page.locator(".ProseMirror > p").last().click();
    const header = await table.locator("th").first().evaluate(node => getComputedStyle(node).backgroundColor);
    expect(header).not.toBe("rgba(0, 0, 0, 0)");
    expect(header).not.toBe(await table.locator("td").first().evaluate(node => getComputedStyle(node).backgroundColor));
    await table.locator("td").first().hover();
    await expect(whole).toBeVisible();
    await expect(whole).toHaveAttribute("aria-label", "Table actions");
    await expect(row).toHaveCSS("opacity", "0");
    await expect(column).toHaveCSS("opacity", "0");
    await capture(page, `table-hover-whole-handle-${width}`, browserName);
    await table.locator(".folio-table-add-region-row").hover();
    await expect(row).toHaveCSS("opacity", "1");
    await expect(column).toHaveCSS("opacity", "0");
    await capture(page, `table-row-region-${width}`, browserName);
    await table.locator(".folio-table-add-region-column").hover();
    await expect(column).toHaveCSS("opacity", "1");
    await expect(row).toHaveCSS("opacity", "0");
    await capture(page, `table-column-region-${width}`, browserName);
    await page.mouse.move(5, 5);
    await expect(whole).toBeHidden();
    await expect(row).toHaveCSS("opacity", "0");
    await expect(column).toHaveCSS("opacity", "0");
    await chooseView(page, "preview");
    expect(await page.locator("#preview th").first().evaluate(node => getComputedStyle(node).backgroundColor)).toBe(header);
  });
}

test("whole-table handle applies settings, deletes, duplicates and exports without losing data", async ({ page, browserName }) => {
  await openFixture(page, "Table-whole-actions.md", source);
  await page.evaluate(() => {
    window.tableCopies = [];
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true, value: async value => { window.tableCopies.push(value); },
    });
  });
  const tables = page.locator(".folio-table-wrapper");
  const menu = tools(page);
  await page.locator(".ProseMirror > p").last().click();
  await openTableTools(page, 0, "table");
  await expect(menu.locator(".folio-table-menu-heading")).toHaveText("Table settings");
  await expect(menu.getByRole("menuitem", { name: "Delete table", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitemradio")).toHaveCount(3);
  await expect(menu.getByRole("combobox")).toHaveCount(0);
  await capture(page, "whole-table-settings-menu", browserName);
  await menu.getByRole("menuitemradio", { name: "Align center", exact: true }).click();
  expect(await tables.locator("th, td").evaluateAll(nodes => nodes.every(node => getComputedStyle(node).textAlign === "center"))).toBe(true);
  await openTableTools(page, 0, "table");
  await menu.getByRole("menuitem", { name: "Clear contents", exact: true }).click();
  await expect(tables.locator("th, td")).toHaveText(Array(9).fill(""));
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(tables.locator("td")).toHaveText(["A", "Draft", "One", "B", "Ready", "Two"]);
  await openTableTools(page, 0, "table");
  await menu.getByRole("menuitem", { name: "Duplicate table", exact: true }).click();
  await expect(tables).toHaveCount(2);
  await openTableTools(page, 1, "table");
  await menu.getByRole("menuitem", { name: "Delete table", exact: true }).click();
  await expect(tables).toHaveCount(1);
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(tables).toHaveCount(2);
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(tables).toHaveCount(1);
  await openTableTools(page, 0, "table");
  await menu.locator(".folio-table-export > summary").click();
  await menu.getByRole("button", { name: "Copy table as CSV", exact: true }).click();
  expect(await page.evaluate(() => window.tableCopies.at(-1))).toBe("Name,State,Owner\r\nA,Draft,One\r\nB,Ready,Two\r\n");
  await menu.press("Escape");
  await page.keyboard.press(`${primaryModifier}+s`);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  expect(await fs.readFile(path.join(root, "Table-whole-actions.md"), "utf8")).toContain("Draft");
  await page.reload();
  await expect(tables.locator("td")).toHaveText(["A", "Draft", "One", "B", "Ready", "Two"]);
  expect(await tables.locator("th, td").evaluateAll(nodes => nodes.every(node => getComputedStyle(node).textAlign === "center"))).toBe(true);
  await page.setViewportSize({ width: 390, height: 450 });
  await openTableTools(page, 0, "table");
  await menu.locator(".folio-table-export > summary").click();
  await expect.poll(async () => {
    const popup = await menu.boundingBox();
    const viewport = await page.locator(".folio-live-scroll").boundingBox();
    return popup.y >= viewport.y && popup.y + popup.height <= viewport.y + viewport.height;
  }).toBe(true);
  const popup = await menu.boundingBox();
  const viewport = await page.locator(".folio-live-scroll").boundingBox();
  expect(popup.y).toBeGreaterThanOrEqual(viewport.y);
  expect(popup.y + popup.height).toBeLessThanOrEqual(viewport.y + viewport.height);
  expect(popup.x + popup.width).toBeLessThanOrEqual(382);
  await capture(page, "whole-table-settings-short-viewport", browserName);
});

test("alignment uses consistent vertical menu rows and Escape exits cell selection without changing Markdown", async ({ page, browserName }) => {
  await openFixture(page, "Table-escape.md", source);
  const table = page.locator(".folio-table-wrapper");
  const cell = table.locator("td").nth(1);
  const outline = table.locator(".folio-table-selection");
  await cell.click();
  await page.mouse.move(5, 5);
  await expect(outline).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(outline).toBeHidden();
  await expect(table).not.toHaveClass(/is-active/);
  await expect(page.locator(".ProseMirror")).not.toBeFocused();
  await expect(page.locator("#editor")).toHaveValue(source);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  await capture(page, "table-escape-dismissed", browserName);
  await cell.click();
  await expect(outline).toBeVisible();
  const menu = await openTableTools(page);
  await expect(menu.locator(".folio-table-export")).toBeHidden();
  const style = node => {
    const value = getComputedStyle(node);
    return { font: value.font, padding: value.padding, height: node.getBoundingClientRect().height };
  };
  expect(await menu.getByRole("menuitemradio", { name: "Align center", exact: true }).evaluate(style))
    .toEqual(await menu.getByRole("menuitem", { name: "Insert left", exact: true }).evaluate(style));
  await capture(page, "table-alignment-menu-rows", browserName);
  await menu.getByRole("menuitemradio", { name: "Align right", exact: true }).click();
  await expect(table.locator("th").nth(1)).toHaveCSS("text-align", "right");
  await expect(table.locator("th").first()).toHaveCSS("text-align", "left");
  const changed = await page.locator("#editor").inputValue();
  await page.keyboard.press("Escape");
  await expect(outline).toBeHidden();
  await expect(page.locator("#editor")).toHaveValue(changed);
  await cell.click();
  await expect(outline).toBeVisible();
  await openTableTools(page, 0, "table");
  await menu.press("Escape");
  await expect(outline).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(outline).toBeHidden();
  await expect(page.locator("#editor")).toHaveValue(changed);
});

test("Copy as belongs only to the whole-table block menu, not row or column menus", async ({ page }) => {
  await openFixture(page, "Table-copy-scope.md", source);
  const menu = tools(page);
  for (const axis of ["row", "column", "table", "column", "row"]) {
    await openTableTools(page, 0, axis);
    if (axis === "table") await expect(menu.locator(".folio-table-export > summary")).toBeVisible();
    else {
      await expect(menu.locator(".folio-table-export")).toBeHidden();
      await expect(menu.getByText("Copy table as", { exact: true })).toBeHidden();
    }
  }
});

test("the whole-table menu preserves an existing column selection rather than expanding it", async ({ page }) => {
  await openFixture(page, "Table-preserved-axis-selection.md", source);
  const table = page.locator(".folio-table-wrapper");
  await table.locator("td").first().click();
  await openTableTools(page, 0, "column");
  await expect(table.locator(".selectedCell")).toHaveCount(3);
  const before = await table.locator(".folio-table-selection").boundingBox();
  const grip = page.locator(".folio-block-grip");
  await grip.click();
  const menu = tools(page);
  await expect(menu.locator(".folio-table-menu-heading")).toBeVisible();
  await expect(table.locator(".selectedCell")).toHaveCount(3);
  expect(await table.locator(".folio-table-selection").boundingBox()).toEqual(before);
  await grip.click();
  await expect(menu).toBeHidden();
  await expect(table.locator(".selectedCell")).toHaveCount(3);
  await page.keyboard.press("Escape");
  await expect(table.locator(".folio-table-selection")).toBeHidden();
  await expect(page.locator("#editor")).toHaveValue(source);
});

test("the whole-table menu follows its grip while scrolling without moving the caret into the table", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 600 });
  await openFixture(page, "Table-menu-scroll.md", "Before.\n\n" + source + "\nTail.\n\n".repeat(25));
  await page.locator(".ProseMirror > p").first().click();
  const table = page.locator(".folio-table-wrapper");
  const menu = await openTableTools(page, 0, "table");
  await expect(table.locator(".folio-table-selection")).toBeHidden();
  await page.locator(".folio-live-scroll").evaluate(node => { node.scrollTop += 28; });
  await expect.poll(async () => {
    const popup = await menu.boundingBox();
    const grip = await page.locator(".folio-block-grip").boundingBox();
    return Math.abs(popup.y - grip.y - grip.height - 6);
  }).toBeLessThan(1);
  await expect(table.locator(".selectedCell")).toHaveCount(0);
  await expect(table.locator(".folio-table-selection")).toBeHidden();
});
