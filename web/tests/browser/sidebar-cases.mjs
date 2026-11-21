import { test, expect, openFixture, primaryModifier } from "./fixture.mjs";

test("a menu reopens cleanly after closing, however quickly it is clicked", async ({ page }) => {
  const trigger = page.locator("#more-menu > summary");
  const panel = page.locator("#more-actions-panel");
  await trigger.click();
  await expect(panel).toBeVisible();
  await trigger.click();
  await expect(panel).toBeHidden();
  for (let round = 0; round < 3; round += 1) {
    await trigger.click();
    await expect(panel).toBeVisible();
    await expect(panel).not.toHaveAttribute("data-closed", "");
    await expect(panel).toHaveCSS("opacity", "1");
    await expect(panel).toHaveCSS("pointer-events", "auto");
    await trigger.click();
    await trigger.click();
    await expect(panel).toHaveCSS("opacity", "1");
    await trigger.click();
    await expect(panel).toBeHidden();
  }
});

test("one sidebar button creates notes and folders and every menu action has an icon", async ({ page }) => {
  await expect(page.locator("#refresh-files, #files-tab, #sidebar-workspace-open")).toHaveCount(0);
  const search = await page.locator(".sidebar-search").boundingBox();
  const create = await page.locator("#new-menu > summary").boundingBox();
  expect(create.x).toBeGreaterThanOrEqual(search.x + search.width);
  expect(Math.abs(create.y + create.height / 2 - (search.y + search.height / 2))).toBeLessThan(2);
  await page.locator("#new-menu > summary").click();
  await expect(page.locator("#new-note")).toBeVisible();
  await expect(page.locator("#new-folder")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator("#more-menu > summary").click();
  const missing = await page.locator("#more-actions-panel").evaluate(panel =>
    [...panel.querySelectorAll("button, summary")]
      .filter(node => node.getClientRects().length && !node.dataset.pageWidth && !node.querySelector(":scope > svg.menu-icon"))
      .map(node => node.textContent.trim()));
  expect(missing).toEqual([]);
  await expect(page.locator("#compact-layout-menu")).toBeVisible();
  await expect(page.locator("#layout-menu")).toHaveCount(0);
  await expect(page.locator("#file-list [title]")).toHaveCount(0);
});

test("a chosen entry icon survives a reload and the command panel finds notes", async ({ page }) => {
  await openFixture(page, "Icon-target.md", "# Icon target\n");
  const row = page.locator('#file-list [data-path="Icon-target.md"]');
  await row.click({ button: "right" });
  await page.locator('#file-icon-choices [data-entry-icon="star"]').click();
  await expect(page.locator("#file-context-menu")).toBeHidden();
  await expect(row.locator('svg[data-icon="star"]')).toBeVisible();
  await page.reload();
  await expect(page.locator('#file-list [data-path="Icon-target.md"] svg[data-icon="star"]')).toBeVisible();
  await page.locator('#file-list [data-path="Icon-target.md"]').click({ button: "right" });
  await page.locator('#file-icon-choices [data-entry-icon=""]').click();
  await expect(page.locator('#file-list [data-path="Icon-target.md"] svg[data-icon="file"]')).toBeVisible();

  await page.locator(".ProseMirror").click();
  await page.keyboard.press(`${primaryModifier}+k`);
  await page.locator("#command-query").fill("icon-tar");
  await expect(page.locator("#command-list [role=option]")).toHaveText(/Icon-target/);
});
