import { test, expect, primaryModifier, chooseView, openSettingsDialog } from "./fixture.mjs";

test("footer hints stay in the floating list and an empty workspace remains quiet", async ({ page }) => {
  await expect(page.locator(".status-bar #dirty-indicator, .status-bar #connection-label")).toHaveCount(0);
  await chooseView(page, "editor");
  let release;
  let began;
  const pending = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { began = resolve; });
  await page.route("**/api/document", async route => {
    if (route.request().method() !== "PUT") return route.continue();
    began();
    await pending;
    await route.continue();
  });
  try {
    await page.locator("#editor").fill("# Footer stays quiet\n");
    await page.keyboard.press(`${primaryModifier}+s`);
    await started;
    await expect(page.locator("#status-notices #dirty-indicator")).toHaveText("Saving…");
    await expect(page.locator(".status-bar")).not.toContainText("Saving");
    release();
    await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    await page.goto(new URL("/", page.url()).href);
    await expect(page.locator("#document-title")).toHaveText("Select a note");
    await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "empty");
    await expect(page.locator("#dirty-indicator")).toBeHidden();
    await expect(page.locator(".status-bar")).not.toContainText("No note open");
    await expect(page.locator("#status-notices")).not.toContainText("No note open");
  } finally { release(); }
});

test("a dialog error remains above the modal when a background status was already floating", async ({ page }) => {
  await page.route("**/api/tree", route => route.fulfill({ status: 503, json: { error: "Background status remains visible." } }));
  await page.locator("#refresh-files").click();
  await expect(page.locator("#tree-message")).toContainText("Background status");
  await page.route("**/api/preferences", route => route.request().method() === "PUT"
    ? route.fulfill({ status: 503, json: { error: "Settings could not be saved for this status test." } })
    : route.continue());
  await openSettingsDialog(page);
  await page.locator("#settings-save").click();
  const stack = page.locator("#status-notices");
  await expect(stack).toContainText("Settings could not be saved");
  await expect(stack).toHaveAttribute("role", "alert");
  const message = stack.getByText("Settings could not be saved for this status test.", { exact: true });
  const bounds = await message.boundingBox();
  expect(await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest("#status-notices")), {
    x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2,
  })).toBe(true);
  await page.locator("#settings-cancel").click();
  await expect(stack).not.toContainText("Settings could not be saved");
});

test("status errors form a readable floating list in desktop, dark and narrow layouts", async ({ page, browserName }) => {
  const before = await page.locator("#document-panes").boundingBox();
  await page.route("**/api/tree", route => route.fulfill({
    status: 503, json: { error: "The file list is temporarily unavailable. The current note remains editable." },
  }));
  await page.route("**/api/appearance", route => route.fulfill({
    status: 503, json: { error: "Appearance could not be checked. Current display settings and local text are retained." },
  }));
  await page.locator("#refresh-files").click();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator("#tree-message")).toContainText("temporarily unavailable");
  await expect(page.locator("#appearance-message")).toContainText("could not be checked");
  const stack = page.locator("#status-notices");
  await expect(stack).toBeVisible();
  expect(await stack.evaluate(node => node.parentElement === document.body && node.matches(":popover-open"))).toBe(true);
  await expect(page.locator(".status-bar .notice, .status-bar .status-message")).toHaveCount(0);
  expect(await page.locator("#document-panes").boundingBox()).toEqual(before);
  if (browserName !== "webkit") {
    await page.screenshot({ path: test.info().outputPath("status-float-desktop.png"), caret: "initial" });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: test.info().outputPath("status-float-dark.png"), caret: "initial" });
    await page.emulateMedia({ colorScheme: "light" });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await stack.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(8);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(382);
  const footer = await page.locator(".status-bar").boundingBox();
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(footer.y - 6);
  expect(bounds.y + bounds.height).toBeGreaterThan(footer.y - 25);
  if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath("status-float-narrow.png"), caret: "initial" });
  await page.locator(".ProseMirror p").first().click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" Still editable.");
  await expect(page.locator(".ProseMirror")).toContainText("Still editable.");
  await page.keyboard.press(`${primaryModifier}+z`);
});
