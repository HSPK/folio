import { test, expect, primaryModifier, chooseView, openMoreAction, openSettingsDialog } from "./fixture.mjs";

test("copy works without the async clipboard and keeps the editor unchanged", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read"]);
  const clipboard = await page.evaluateHandle(() => navigator.clipboard);
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined }));
  const source = await page.locator("#editor").inputValue();
  await openMoreAction(page, "copy-text");
  await expect(page.locator("#copy-status")).toHaveText("Copied");
  expect(await clipboard.evaluate(value => value.readText())).toBe(source);
  await expect(page.locator(".ProseMirror")).toBeVisible();
});

test("startup reconnects after a transport failure without a manual action", async ({ page }) => {
  let attempts = 0;
  await page.route("**/api/auth/status", route => ++attempts < 3 ? route.abort("connectionrefused") : route.continue());
  await page.reload();
  await expect(page.locator("#status-notices .status-card:visible")).toHaveText(["Disconnected"]);
  await expect(page.locator("#connection-label")).toHaveAttribute("data-state", "ready", { timeout: 15000 });
  await expect(page.locator(".ProseMirror")).toBeVisible();
  expect(attempts).toBe(3);
});

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
  await page.route("**/api/tree", route => route.fulfill({ status: 422, json: { error: "Background status remains visible." } }));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
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

test("an outage shows one passive status and reconnects automatically", async ({ page, browserName }) => {
  const before = await page.locator("#document-panes").boundingBox();
  await page.route("**/api/tree", route => route.fulfill({
    status: 503, json: { error: "The file list is temporarily unavailable. The current note remains editable." },
  }));
  await page.route("**/api/appearance", route => route.fulfill({
    status: 503, json: { error: "Appearance could not be checked. Current display settings and local text are retained." },
  }));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const stack = page.locator("#status-notices");
  await expect(stack.locator(".status-card:visible")).toHaveText(["Disconnected"]);
  await expect(stack.getByRole("button")).toHaveCount(0);
  await expect(page.locator("#reconnect")).toHaveCount(0);
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
  await expect(page.getByText("Disconnected", { exact: true })).toBeVisible();
  const bounds = await stack.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(8);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(382);
  expect(page.viewportSize().height - bounds.y - bounds.height).toBeCloseTo(18, 0);
  if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath("status-float-narrow.png"), caret: "initial" });
  await page.locator(".ProseMirror p").first().click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" Still editable.");
  await expect(page.locator(".ProseMirror")).toContainText("Still editable.");
  await page.keyboard.press(`${primaryModifier}+z`);
  await page.unroute("**/api/tree");
  await page.unroute("**/api/appearance");
  await expect(page.locator("#connection-label")).toHaveAttribute("data-state", "ready");
  await expect(page.locator("#connection-label")).toBeHidden();
});
