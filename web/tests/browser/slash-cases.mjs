import { test, expect, openFixture } from "./fixture.mjs";

for (const [side, narrow] of [["above", false], ["below", false], ["above", true]]) {
  test(`slash menu stays anchored ${side} during filtering and refresh ${narrow ? "on a narrow screen" : "on desktop"}`, async ({ page, browserName }) => {
    await page.setViewportSize({ width: narrow ? 390 : 1440, height: 650 });
    const source = `${"Before.\n\n".repeat(25)}/\n\n${"After.\n\n".repeat(25)}`;
    await openFixture(page, `Slash-position-${side}-${narrow}.md`, source);
    const paragraph = page.locator(".ProseMirror p").filter({ hasText: /^\/h?$/ });
    await paragraph.evaluate((node, side) => {
      const scroller = node.closest("[data-editor-scroller]");
      const viewport = scroller.getBoundingClientRect();
      const bounds = node.getBoundingClientRect();
      const top = side === "above" ? viewport.bottom - 70 : viewport.top + 24;
      scroller.scrollTop += bounds.top - top;
    }, side);
    await paragraph.click();
    const menu = page.locator("#folio-slash-menu");
    await expect(menu).toBeVisible();
    const anchor = await paragraph.boundingBox();
    const stable = async () => {
      const samples = await menu.evaluate(async node => {
        const result = [];
        for (let index = 0; index < 12; index++) {
          await new Promise(resolve => requestAnimationFrame(resolve));
          const bounds = node.getBoundingClientRect();
          result.push({ top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right });
        }

        return result;
      });
      const values = samples.map(bounds => side === "above" ? bounds.bottom : bounds.top);
      expect(Math.max(...values) - Math.min(...values)).toBeLessThan(1);
      for (const bounds of samples) {
        expect(bounds.top).toBeGreaterThanOrEqual(11);
        expect(bounds.bottom).toBeLessThanOrEqual(639);
        expect(bounds.left).toBeGreaterThanOrEqual(11);
        expect(bounds.right).toBeLessThanOrEqual((narrow ? 390 : 1440) - 11);
        if (side === "above") expect(bounds.bottom).toBeLessThanOrEqual(anchor.y);
        else expect(bounds.top).toBeGreaterThan(anchor.y);
      }
      return values[0];
    };
    const origin = await stable();
    await page.keyboard.insertText("h");
    await expect(menu.getByRole("option")).toHaveCount(3);
    expect(Math.abs(await stable() - origin)).toBeLessThan(1);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowUp");
    await page.waitForTimeout(250);
    expect(Math.abs(await stable() - origin)).toBeLessThan(1);
    await page.keyboard.press("Backspace");
    await expect(menu.getByRole("option")).toHaveCount(13);
    expect(Math.abs(await stable() - origin)).toBeLessThan(1);
    await page.keyboard.press("ArrowUp");
    const last = menu.getByRole("option", { name: "Divider", exact: true });
    await expect(last).toHaveAttribute("aria-selected", "true");
    expect(await last.evaluate(node => {
      const bounds = node.getBoundingClientRect();
      const parent = node.parentElement.getBoundingClientRect();
      return bounds.top >= parent.top && bounds.bottom <= parent.bottom;
    })).toBe(true);
    expect(Math.abs(await stable() - origin)).toBeLessThan(1);
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("option", { name: "Text", exact: true })).toHaveAttribute("aria-selected", "true");
    expect(Math.abs(await stable() - origin)).toBeLessThan(1);
    expect(Math.abs((await paragraph.boundingBox()).y - anchor.y)).toBeLessThan(1);
    await expect(paragraph).toHaveText("/");
    if (browserName !== "webkit") await page.screenshot({
      path: test.info().outputPath(`stable-slash-${side}-${narrow ? "narrow" : "desktop"}.png`), caret: "initial",
    });
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(paragraph).toHaveText("/");
  });
}

for (const width of [1440, 390]) {
  test(`filtered slash commands show compact results without persisting query styles at ${width}px`, async ({ page, browserName }) => {
    await page.setViewportSize({ width, height: 844 });
    await openFixture(page, `Slash-results-${width}.md`, "");
    const editor = page.locator(".ProseMirror");
    const menu = page.locator("#folio-slash-menu");
    await editor.click();
    await editor.pressSequentially("/tab");
    await expect(menu).toBeVisible();
    await expect(menu.locator(".folio-slash-heading")).toHaveText("Filtered results");
    await expect(menu.getByRole("option")).toHaveCount(1);
    await expect(menu.getByRole("option", { name: "Table", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(editor.locator(".folio-slash-query")).toHaveText("/tab");
    await expect(page.locator("#editor")).toHaveValue(/^\/tab\n?$/);
    if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath(`notion-slash-results-${width}.png`), caret: "initial" });
    await editor.press("Escape");
    await expect(menu).toBeHidden();
    await expect(editor.locator(".folio-slash-query")).toHaveCount(0);
    await expect(editor).toHaveText("/tab");
  });
}
