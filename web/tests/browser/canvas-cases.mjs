import { test, expect, openFixture, chooseView, openSettingsDialog } from "./fixture.mjs";

const source = "# A canvas for your thoughts\n\nThe document belongs on the canvas, not in a card.\n\n## Next\n\nKeep writing.\n";

for (const theme of ["light", "dark"]) {
  test(`canvas keeps writing frameless and chrome in floating panels in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await openFixture(page, `Canvas-${theme}.md`, source);
    for (const selector of ["#sidebar", "#more-menu > button"]) {
      const panel = page.locator(selector);
      await expect(panel).toBeVisible();
      const appearance = await panel.evaluate(node => {
        const style = getComputedStyle(node);
        const bounds = node.getBoundingClientRect();
        return {
          radius: parseFloat(style.borderRadius), fill: style.backgroundImage,
          border: parseFloat(style.borderTopWidth),
          inset: Math.min(bounds.left, bounds.top, innerWidth - bounds.right, innerHeight - bounds.bottom),
        };
      });
      expect(appearance.radius).toBeGreaterThanOrEqual(12);
      if (selector === "#sidebar") expect(appearance.fill).toContain("linear-gradient");
      expect(appearance.border).toBe(selector === "#sidebar" ? 1 : 0);
      expect(appearance.inset).toBeGreaterThanOrEqual(8);
    }
    await expect(page.locator(".document-area > header")).toHaveCount(0);
    await expect(page.locator("#sidebar-toggle")).toBeHidden();
    const more = page.locator("#more-menu > button");
    await expect(more).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await more.hover();
    await expect(more).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    const trigger = await page.locator("#more-menu > button").boundingBox();
    expect(trigger.height).toBe(trigger.width);
    expect(page.viewportSize().width - trigger.x - trigger.width).toBeLessThan(24);
    expect(trigger.y).toBeLessThan(24);
    for (const selector of [".document-area", "#document-panes", ".folio-live-page"]) {
      await expect(page.locator(selector)).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(page.locator(selector)).toHaveCSS("box-shadow", "none");
      await expect(page.locator(selector)).toHaveCSS("border-top-width", "0px");
    }
    for (const view of ["editor", "preview", "split", "rich"]) {
      await chooseView(page, view);
      await expect(page.locator("#editor")).toHaveValue(source);
      const surface = page.locator(view === "rich" ? ".folio-live-page" : view === "preview" ? "#preview" : "#editor");
      await expect(surface).toBeVisible();
      await expect(surface).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    }
    await page.screenshot({ path: test.info().outputPath(`canvas-${theme}.png`), animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("#sidebar")).toBeHidden();
    await page.locator("#sidebar-toggle").click();
    await expect(page.locator("#sidebar")).toBeVisible();
    await expect(page.locator("#sidebar")).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
    const narrow = await page.locator("#sidebar").boundingBox();
    expect(narrow.x).toBeGreaterThanOrEqual(8);
    expect(narrow.y).toBeGreaterThanOrEqual(8);
    expect(narrow.y + narrow.height).toBeLessThanOrEqual(836);
    await page.locator("#sidebar-hide").click();
    await expect(page.locator("#sidebar")).toBeHidden();
    expect(await page.locator("#sidebar").evaluate(node => node.inert)).toBe(true);
    await expect(page.locator(".ProseMirror")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`canvas-${theme}-narrow.png`), animations: "disabled" });
  });
}

test("Live and Read keep the same paragraph and heading spacing at either density", async ({ page }) => {
  await openFixture(page, "Document-spacing.md", source);
  let previous;
  for (const density of ["comfortable", "compact"]) {
    await page.locator("html").evaluate((node, value) => { node.dataset.density = value; }, density);
    const spacing = async root => root.evaluate(node => {
      const p = getComputedStyle(node.querySelector("p"));
      return [parseFloat(p.marginBottom), parseFloat(getComputedStyle(node.querySelector("h2")).marginTop), p.lineHeight];
    });
    await chooseView(page, "rich");
    const live = await spacing(page.locator(".ProseMirror"));
    await chooseView(page, "preview");
    expect(await spacing(page.locator("#preview"))).toEqual(live);
    if (previous) {
      expect(live[0]).toBeLessThan(previous[0]);
      expect(live[1]).toBeLessThan(previous[1]);
      expect(live[2]).toBe(previous[2]);
    }
    previous = live;
  }
});

test("action menus fit visible options and follow the canvas theme", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
  await page.locator("#new-menu > button").click();
  const newMenu = page.locator("#new-menu-panel");
  const width = async panel => (await panel.boundingBox()).width;
  const compact = await width(newMenu);
  expect(compact).toBeLessThan(160);
  const option = newMenu.locator("#new-folder");
  await option.evaluate(node => node.append(" with a much longer label"));
  expect(await width(newMenu)).toBeGreaterThan(compact);
  await option.evaluate(node => { node.hidden = true; });
  expect(await width(newMenu)).toBeLessThanOrEqual(compact);
  await page.keyboard.press("Escape");
  await page.locator("#more-menu > button").click();
  const more = page.locator("#more-actions-panel");
  const before = await width(more);
  await page.locator("#document-name").evaluate(node => { node.textContent = "long title ".repeat(100); });
  expect(await width(more)).toBe(before);
  const fill = () => more.evaluate(node => getComputedStyle(node).backgroundColor);
  const light = await fill();
  expect(light).not.toBe("rgba(0, 0, 0, 0)");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(fill).not.toBe(light);
  await page.keyboard.press("Escape");
  await expect(more).toBeHidden();
  await page.setViewportSize({ width: 320, height: 480 });
  await page.locator("#more-menu > button").click();
  await expect(page.locator("#settings-open")).toBeInViewport();
  expect(await more.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
});

test("canvas panels fade on both entry and exit without delaying sidebar state or editor input", async ({ page }) => {
  await openFixture(page, "Canvas-motion.md", source);
  const transitions = await page.evaluate(() => {
    document.getElementById("sidebar-hide").click();
    const sidebar = document.getElementById("sidebar");
    getComputedStyle(sidebar).opacity;
    return {
      closed: document.body.dataset.sidebar === "closed",
      inert: sidebar.inert,
      fades: sidebar.getAnimations().some(animation => animation.transitionProperty === "opacity"),
    };
  });
  expect(transitions).toEqual({ closed: true, inert: true, fades: true });
  await expect(page.locator("#sidebar")).toBeHidden();
  await page.locator("#sidebar-toggle").click();
  await expect(page.locator("#sidebar")).toBeVisible();
  await expect(page.locator("#sidebar")).toHaveCSS("opacity", "1");
  await page.locator("#more-menu > button").click();
  const menuPanel = page.locator("#more-actions-panel");
  const originalPanel = await menuPanel.elementHandle();
  await expect(menuPanel).toHaveCSS("opacity", "1");
  const menuExit = await menuPanel.evaluate(node => {
    node.hidePopover();
    getComputedStyle(node).opacity;
    return { inert: node.inert, fades: node.getAnimations().some(animation => animation.animationName === "folio-more-out") };
  });
  expect(menuExit).toEqual({ inert: true, fades: true });
  await expect(menuPanel).toBeHidden();
  await page.locator("#more-menu > button").click();
  expect(await menuPanel.evaluate((node, previous) => node === previous, originalPanel)).toBe(true);
  expect(await menuPanel.evaluate(node => node.inert)).toBe(false);
  await page.keyboard.press("Escape");
  await expect(menuPanel).toBeHidden();
  await openSettingsDialog(page);
  await expect(page.locator("#settings-dialog")).toHaveCSS("opacity", "1");
  const closing = await page.locator("#settings-dialog").evaluate(node => {
    node.close();
    getComputedStyle(node).opacity;
    return { closed: !node.open, fades: node.getAnimations().some(animation => animation.transitionProperty === "opacity") };
  });
  expect(closing).toEqual({ closed: true, fades: true });
  await expect(page.locator("#settings-dialog")).toBeHidden();
  await page.locator(".ProseMirror > p").first().click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" Still editable.");
  await expect(page.locator(".ProseMirror")).toContainText("Still editable.");
});

for (const preference of ["system", "application"]) {
  test(`canvas motion respects the ${preference} reduced-motion preference`, async ({ page }) => {
    if (preference === "system") await page.emulateMedia({ reducedMotion: "reduce" });
    else await page.locator("html").evaluate(node => { node.dataset.reducedMotion = "true"; });
    for (const selector of ["#sidebar", "#more-menu > button", "#outline-panel"]) {
      const durations = await page.locator(selector).evaluate(node => getComputedStyle(node).transitionDuration);
      expect(durations.split(",").every(value => parseFloat(value) === 0)).toBe(true);
    }
    await openSettingsDialog(page);
    await expect(page.locator("#settings-dialog")).toHaveCSS("opacity", "1");
    const animations = await page.locator("#settings-dialog").evaluate(node =>
      node.getAnimations({ subtree: true }).filter(animation => Number(animation.effect.getTiming().duration) > 0).length);
    expect(animations).toBe(0);
    await page.keyboard.press("Escape");
    await expect(page.locator("#settings-dialog")).toBeHidden();
  });
}
