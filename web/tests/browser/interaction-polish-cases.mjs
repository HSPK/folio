import {
  test, expect, openSettingsDialog, selectSettingsSection, openMoreAction, openImageOptions, primaryModifier,
} from "./fixture.mjs";
import { imageFixture } from "./node-tools-cases.mjs";
import { collaborativeLibrary } from "./collaboration-cases.mjs";

test("non-critical messages collapse in a modal, avoid Save and can be dismissed", async ({ page, browserName }) => {
  await page.setViewportSize({ width: 390, height: 680 });
  await page.route("**/api/appearance", route => route.fulfill({
    json: { theme: "system", latinFont: "sans-serif", cjkFont: "Folio Missing Audit Font" },
  }));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const warning = page.locator("#appearance-message");
  await expect(warning).toContainText("unavailable");
  await openSettingsDialog(page, { section: "appearance" });
  const font = page.locator("#settings-cjk-font");
  await font.focus();
  await expect(font).toBeFocused();
  const toggle = page.getByRole("button", { name: "Toggle status messages", exact: true });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(warning).toBeVisible();
  await expect.poll(async () => {
    const stack = await page.locator("#status-notices").boundingBox();
    const actions = await page.locator(".settings-actions").boundingBox();
    return stack.y + stack.height <= actions.y - 7;
  }).toBe(true);
  const save = await page.locator("#settings-save").boundingBox();
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, {
    x: save.x + save.width / 2, y: save.y + save.height / 2,
  })).toBe("settings-save");
  await page.locator("#settings-save").click({ trial: true });
  if (browserName !== "webkit") {
    await page.screenshot({ path: test.info().outputPath("warning-avoids-modal-actions.png") });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: test.info().outputPath("warning-avoids-modal-actions-dark.png") });
    await page.emulateMedia({ colorScheme: "light" });
  }
  const card = page.locator(".status-card").filter({ has: warning });
  await card.getByRole("button", { name: "Dismiss message" }).click();
  await expect(card).toBeHidden();
  await expect(font).toBeFocused();
});

test("actionable modal errors remain visible when other messages are collapsed", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 680 });
  await page.route("**/api/preferences", route => route.request().method() === "PUT"
    ? route.fulfill({ status: 503, json: { error: "Preferences could not be saved." } }) : route.continue());
  await openSettingsDialog(page);
  await page.locator("#settings-save").click();
  const error = page.locator("#settings-error");
  await expect(error).toBeVisible();
  await expect(error).toHaveText("Preferences could not be saved.");
  await expect(page.locator("#status-notices")).toHaveAttribute("role", "alert");
  await expect(page.locator(".status-card").filter({ has: error }).getByRole("button", { name: "Dismiss message" })).toHaveCount(0);
  await page.locator("#settings-cancel").click();
  await expect(error).toBeHidden();
});

for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 680 }]) {
test(`settings use scoped navigation without clipped tabs at ${viewport.width}px`, async ({ page, browserName }) => {
  await page.setViewportSize(viewport);
  await openSettingsDialog(page);
  await expect(page.locator('[data-settings-panel="editor"]')).toBeVisible();
  await expect(page.locator('[data-settings-group="Writing preferences"]')).toHaveCount(1);
  if (viewport.width < 650) {
    await expect(page.locator(".settings-tabs")).toBeHidden();
    await expect(page.getByRole("combobox", { name: "Settings section", exact: true })).toBeVisible();
    await selectSettingsSection(page, "performance");
    await expect(page.getByRole("heading", { name: "Advanced performance tuning" })).toBeVisible();
  } else {
    const writing = page.getByRole("tab", { name: "Writing", exact: true });
    await writing.focus();
    await writing.press("ArrowDown");
    await expect(page.getByRole("tab", { name: "Appearance", exact: true })).toBeFocused();
  }
  await page.locator("#settings-search").fill("no-such-setting-audit");
  await expect(page.locator("#settings-empty")).toBeVisible();
  await page.locator("#settings-search").fill("");
  await selectSettingsSection(page, "library");
  await expect(page.locator("#settings-image-directory")).toBeVisible();
  if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath(`grouped-settings-${viewport.width}.png`) });
});
}

test("More keeps Settings visible while recovery scrolls and exposes licenses through About", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { participants: 1 });
  try {
    const [page] = library.pages;
    await page.setViewportSize({ width: 780, height: 420 });
    await page.locator("#more-menu > summary").click();
    await expect(page.locator("#more-document-actions")).toBeVisible();
    await expect(page.locator("#more-workspace-actions")).toBeVisible();
    await expect(page.locator("#history-open")).toBeHidden();
    const before = await page.locator("#settings-open").boundingBox();
    await page.locator(".more-menu-scroll").evaluate(node => { node.scrollTop = node.scrollHeight; });
    await page.locator("#more-recovery > summary").click();
    await page.locator(".more-menu-scroll").evaluate(node => { node.scrollTop = node.scrollHeight; });
    const after = await page.locator("#settings-open").boundingBox();
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
    await expect(page.locator("#settings-open")).toBeInViewport();
    await page.screenshot({ path: test.info().outputPath("short-menu-pinned-settings.png") });
    await openMoreAction(page, "about-open");
    await expect(page.locator("#about-dialog")).toBeVisible();
    await expect(page.locator("#about-dialog").getByRole("link", { name: "Third-party licenses" }))
      .toHaveAttribute("href", "/THIRD-PARTY-LICENSES.txt");
    await page.locator("#about-close").click();
    await expect(page.locator("#more-menu > summary")).toBeFocused();
  } finally { await library.close(); }
});

test("collaboration presence is distinct from public sharing and view mode is a disclosure", async ({ browser }) => {
  const library = await collaborativeLibrary(browser);
  try {
    const [page] = library.pages;
    const join = page.locator("#collaboration-join");
    await expect(join).toHaveAttribute("aria-pressed", "true");
    await expect(join).toHaveText("Collaborating");
    await expect(page.locator("#view-menu > summary svg[data-icon=chevron-down]")).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(join).toHaveText(/\d+ online/);
    await page.locator("#more-menu > summary").click();
    await expect(page.locator("#share-page")).toHaveText("Share page");
  } finally { await library.close(); }
});

for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }]) {
test(`image options dock outside the text viewport and retreat during writing at ${viewport.width}px`, async ({ page, browserName }) => {
  await page.setViewportSize(viewport);
  await imageFixture(page, `Inspector-${viewport.width}.md`);
  const original = await page.locator("#editor").inputValue();
  const panel = await openImageOptions(page);
  await expect(panel).toHaveAttribute("data-dock", viewport.width >= 1000 ? "side" : "bottom");
  await test.info().attach("image-inspector-geometry", {
    contentType: "application/json",
    body: JSON.stringify(await page.locator("#rich-editor").evaluate(root => {
      const scroller = root.querySelector(".folio-live-scroll");
      const inspector = document.getElementById("folio-image-options");
      const style = getComputedStyle(scroller);
      return {
        root: root.getBoundingClientRect().toJSON(), viewport: scroller.getBoundingClientRect().toJSON(),
        inspector: inspector.getBoundingClientRect().toJSON(), rootStyle: root.getAttribute("style"),
        viewportStyle: scroller.getAttribute("style"), width: style.width, minWidth: style.minWidth, position: style.position,
      };
    })),
  });
  await expect(panel.getByRole("textbox", { name: "Image width", exact: true })).toBeHidden();
  await expect.poll(async () => {
    const editor = await page.locator(".folio-live-scroll").boundingBox();
    const inspector = await panel.boundingBox();
    return viewport.width >= 1000 ? editor.x + editor.width <= inspector.x : editor.y + editor.height <= inspector.y;
  }).toBe(true);
  await panel.getByRole("button", { name: "Image width 50%", exact: true }).click();
  await expect(page.locator("#editor")).toHaveValue(/width:50%/);
  await expect(panel).toBeVisible();
  if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath(`image-inspector-${viewport.width}.png`) });
  await page.locator(".ProseMirror p").last().click();
  await expect(panel).toBeHidden();
  await expect(page.getByRole("toolbar", { name: "Image tools" })).toBeHidden();
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(page.locator("#editor")).toHaveValue(original);
});
}

test("image validation errors stay visible and successful correction clears only the image error", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await imageFixture(page, "Inspector-validation.md");
  const panel = await openImageOptions(page, { custom: true });
  await panel.getByRole("textbox", { name: "Image width", exact: true }).fill("0");
  await panel.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.locator("#image-message")).toBeVisible();
  await expect(page.locator("#image-message")).toHaveClass(/is-error/);
  await panel.getByRole("textbox", { name: "Image width", exact: true }).fill("25%");
  await panel.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.locator("#image-message")).toBeHidden();
  await expect(page.locator("#editor")).toHaveValue(/width:25%/);
});
