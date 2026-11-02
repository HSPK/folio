import { test, expect, openFixture, hoverBlockTools, openSettingsDialog, primaryModifier } from "./fixture.mjs";
import { imageFixture } from "./node-tools-cases.mjs";

test("block plus focuses a real new paragraph and supports the existing slash insertion menu", async ({ page }) => {
  await openFixture(page, "Block-plus-slash.md", "Before.\n\nAfter.\n");
  await hoverBlockTools(page, page.locator(".ProseMirror > p").first(), "Text");
  await page.getByRole("button", { name: "Add block below", exact: true }).click();
  await expect(page.locator(".ProseMirror")).toBeFocused();
  await page.keyboard.insertText("/h2");
  const menu = page.getByRole("listbox", { name: "Insert block", exact: true });
  await expect(menu).toBeVisible();
  await menu.getByRole("option", { name: "Heading 2", exact: true }).click();
  await page.keyboard.insertText("Added heading");
  await expect(page.locator(".ProseMirror > h2")).toHaveText("Added heading");
  expect(await page.locator(".ProseMirror > h2").evaluate(node => node.previousElementSibling.textContent)).toBe("Before.");
  await expect(page.locator(".ProseMirror > p").last()).toHaveText("After.");
  await page.keyboard.press(`${primaryModifier}+s`);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  await page.reload();
  await expect(page.locator(".ProseMirror > h2")).toHaveText("Added heading");
});

test("hover tools fade both ways, become inert immediately and reopen without a delayed dismissal", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await imageFixture(page, "Hover-tool-motion.md");
  const image = page.locator(".folio-block-image");
  const toolbar = page.locator(".folio-image-tools");
  const controls = page.locator(".folio-block-controls");
  await image.hover();
  await expect(toolbar).toHaveCSS("opacity", "1");
  await expect(controls).toHaveCSS("opacity", "1");
  await page.mouse.move(5, 5);
  await expect(toolbar).toBeHidden();
  await expect(controls).toBeHidden();
  expect(await toolbar.evaluate(node => parseFloat(getComputedStyle(node).transitionDuration))).toBeGreaterThan(0.01);
  await page.evaluate(() => {
    window.toolFadeSamples = [];
    window.recordToolFades = true;
    const sample = () => {
      for (const selector of [".folio-image-tools", ".folio-block-controls"]) {
        const element = document.querySelector(selector);
        window.toolFadeSamples.push({ selector, opening: element.dataset.open === "true", opacity: Number(getComputedStyle(element).opacity) });
      }
      if (window.recordToolFades) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  const before = await image.boundingBox();
  await image.hover();
  await expect.poll(() => page.evaluate(() => new Set(window.toolFadeSamples
    .filter(sample => sample.opening && sample.opacity > 0 && sample.opacity < 1).map(sample => sample.selector)).size)).toBe(2);
  await expect(toolbar).toHaveCSS("opacity", "1");
  await expect(controls).toHaveCSS("opacity", "1");
  expect(await image.boundingBox()).toEqual(before);
  await page.mouse.move(5, 5);
  await expect.poll(() => page.evaluate(() => new Set(window.toolFadeSamples
    .filter(sample => !sample.opening && sample.opacity > 0 && sample.opacity < 1).map(sample => sample.selector)).size)).toBe(2);
  for (const element of [toolbar, controls]) {
    await expect(element).toHaveAttribute("inert", "");
    await expect(element).toHaveAttribute("aria-hidden", "true");
    await expect(element).toHaveCSS("pointer-events", "none");
  }
  await image.hover();
  await expect(toolbar).not.toHaveAttribute("inert");
  await expect(controls).not.toHaveAttribute("inert");
  await expect(toolbar).toHaveCSS("opacity", "1");
  await expect(controls).toHaveCSS("opacity", "1");
  await page.locator(".ProseMirror > p").last().click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" Still editable.");
  await expect(page.locator(".ProseMirror > p").last()).toHaveText("Tail paragraph. Still editable.");
  await page.evaluate(() => { window.recordToolFades = false; });
});

for (const reducedBy of ["system", "preference"]) {
  test(`hover tools honor reduced motion from ${reducedBy}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: reducedBy === "system" ? "reduce" : "no-preference" });
    await imageFixture(page, `Hover-reduced-${reducedBy}.md`);
    if (reducedBy === "preference") {
      await openSettingsDialog(page, { section: "accessibility" });
      await page.locator("#settings-reduced-motion").check();
      await page.locator("#settings-save").click();
      await expect(page.locator("#settings-dialog")).toBeHidden();
      await expect(page.locator("html")).toHaveAttribute("data-reduced-motion", "true");
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("data-reduced-motion", "true");
    }
    const image = page.locator(".folio-block-image");
    await image.hover();
    for (const selector of [".folio-image-tools", ".folio-block-controls"]) {
      const element = page.locator(selector);
      const longest = await element.evaluate(node => Math.max(...getComputedStyle(node).transitionDuration
        .split(",").map(value => parseFloat(value))));
      expect(longest).toBeLessThanOrEqual(0.001);
      await expect(element).toHaveCSS("opacity", "1");
    }
    await page.mouse.move(5, 5);
    await expect(page.locator(".folio-image-tools")).toBeHidden();
    await expect(page.locator(".folio-block-controls")).toBeHidden();
  });
}
