import { test, expect, openSettingsDialog, selectSettingsSection, primaryModifier } from "./fixture.mjs";
import { collaborativeLibrary } from "./collaboration-cases.mjs";

test("Solid workspace fills the viewport and keeps editor nodes stable across chrome changes", async ({ page }) => {
  await expect(page.locator('[data-framework="solid"]')).toBeVisible();
  await expect(page.getByRole("heading", { name: "Opening Folio" })).toHaveCount(0);
  const height = await page.locator("#app-shell").evaluate(node => node.getBoundingClientRect().height);
  expect(height).toBe(page.viewportSize().height);
  const editor = await page.locator(".ProseMirror[contenteditable=true]").elementHandle();
  await openSettingsDialog(page);
  await selectSettingsSection(page, "appearance");
  await selectSettingsSection(page, "layout");
  await page.locator("#settings-cancel").click();
  expect(await page.locator(".ProseMirror[contenteditable=true]").evaluate((node, previous) => node === previous, editor)).toBe(true);
  const duplicateIds = await page.locator("[id]").evaluateAll(nodes => {
    const ids = nodes.map(node => node.id);
    return ids.filter((id, index) => ids.indexOf(id) !== index);
  });
  expect(duplicateIds).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("solid-workspace-desktop.png"), animations: "disabled" });
});

test("Kobalte layers preserve dialog fields and restore the nearest popup trigger on Escape", async ({ page }) => {
  const field = await page.locator("#settings-latin-font").elementHandle();
  await openSettingsDialog(page);
  await selectSettingsSection(page, "appearance");
  await page.locator("#settings-latin-font").fill("Arial");
  await page.locator("#settings-cancel").click();
  await openSettingsDialog(page);
  expect(await page.locator("#settings-latin-font").evaluate((node, previous) => node === previous, field)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.locator("#settings-dialog")).toBeHidden();
  await expect(page.locator("#more-menu > summary")).toBeFocused();
  await page.locator("#view-menu > summary").click();
  await page.locator("#view-rich").focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("#view-editor")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#view-menu")).not.toHaveAttribute("open", "");
  await expect(page.locator("#view-menu > summary")).toBeFocused();
});

test("long Solid search lists virtualize rows and preserve keyboard selection on narrow screens", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { participants: 1, source: true });
  try {
    const [page] = library.pages;
    const results = Array.from({ length: 400 }, (_, index) => ({
      id: `01961e0b-9831-7000-8000-${index.toString(16).padStart(12, "0")}`,
      project: "default",
      path: `Synthetic/Note-${index}.md`,
      title: index === 0 ? "Result <script> remains text" : `Result ${index}`,
      snippet: `An isolated search result ${index}, with enough text to verify wrapping and row measurement.`,
      matchedField: "body",
      offset: 0,
      version: "synthetic-version",
    }));
    await page.route(/\/api\/search(?:\?|$)/, route => route.fulfill({ json: {
      results, projects: [{ id: "default", name: "Synthetic project" }], tags: [], warnings: [], cursor: 0,
      indexing: false, truncated: false,
    } }));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.keyboard.press(`${primaryModifier}+p`);
    await expect(page.locator("#search-dialog")).toBeVisible();
    await expect(page.locator("#search-results")).toHaveAttribute("data-virtualized", "true");
    await expect(page.locator("#search-results")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#search-results script")).toHaveCount(0);
    await expect(page.locator("#search-results")).toContainText("Result <script> remains text");
    await expect.poll(() => page.locator("#search-results > li").count()).toBeLessThan(50);
    for (let index = 0; index < 140; index++) await page.locator("#search-query").press("ArrowDown");
    await expect(page.locator('#search-results button[data-index="140"]')).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('#search-results button[data-index="140"]')).toBeVisible();
    const width = await page.evaluate(() => document.body.scrollWidth);
    expect(width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: test.info().outputPath("solid-search-narrow.png"), animations: "disabled" });
    await page.keyboard.press("Escape");
    await expect(page.locator("#search-dialog")).toBeHidden();
    await openSettingsDialog(page);
    await selectSettingsSection(page, "layout");
    await page.screenshot({ path: test.info().outputPath("solid-settings-narrow.png"), animations: "disabled" });
  } finally {
    await library.close();
  }
});
