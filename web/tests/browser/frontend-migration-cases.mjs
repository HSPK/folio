import { test, expect, openSettingsDialog, selectSettingsSection, primaryModifier } from "./fixture.mjs";
import { collaborativeLibrary } from "./collaboration-cases.mjs";

test("command filtering retains matching rows and handles empty keyboard selection", async ({ page }) => {
  await page.keyboard.press("Control+k");
  const query = page.locator("#command-query");
  const options = page.locator("#command-list [role=option]");
  const read = page.getByRole("option", { name: "View: Read", exact: true });
  const original = await read.elementHandle();
  await query.fill("view:");
  await expect(options).toHaveCount(4);
  expect(await read.evaluate((node, before) => node === before, original)).toBe(true);
  await query.press("ArrowUp");
  await expect(read).toHaveAttribute("aria-selected", "true");
  await query.press("ArrowDown");
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await query.fill("no matching command or note");
  await expect(options).toHaveCount(0);
  await expect(page.locator("#command-empty")).toBeVisible();
  await query.press("ArrowDown");
  await query.press("Enter");
  await expect(page.locator("#command-dialog")).toBeVisible();
  await query.fill("view:");
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await read.hover();
  await expect(read).toHaveAttribute("aria-selected", "true");
  await query.press("Enter");
  await expect(page.locator("#command-dialog")).toBeHidden();
  await expect(page.locator("#document-panes")).toHaveAttribute("data-view", "preview");
  await page.keyboard.press("Control+k");
  await expect(query).toHaveValue("");
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(page.locator("#command-dialog")).toBeHidden();
});

test("native scrollbar visuals stay hidden while settings still scroll", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 280 });
  await openSettingsDialog(page, { section: "editor" });
  const content = page.locator(".settings-content");
  for (const selector of [".settings-content", ".settings-tabs", "#editor"]) {
    expect(await page.locator(selector).evaluate(node => getComputedStyle(node).scrollbarWidth)).toBe("none");
  }
  await expect.poll(() => content.evaluate(node => node.scrollHeight - node.clientHeight)).toBeGreaterThan(0);
  await content.hover();
  await page.mouse.wheel(0, 250);
  await expect.poll(() => content.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
  await page.locator("#settings-cancel").click();
});

test("startup shows one centered heading before the app loads", async ({ page }) => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  await page.route(/\/app\.mjs(?:\?|$)/, async route => { await pending; await route.continue(); });
  try {
    await page.reload({ waitUntil: "commit" });
    const status = page.getByRole("status");
    await expect(status).toHaveText("Opening Folio");
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      const box = await status.getByRole("heading").boundingBox();
      expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThan(1);
      expect(Math.abs(box.y + box.height / 2 - viewport.height / 2)).toBeLessThan(1);
    }
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("startup recovers a transient module failure and offers a retry after persistent failure", async ({ page }) => {
  const documentUrl = page.url();
  let failures = 1;
  let requests = 0;
  await page.route(/\/app\.mjs(?:\?|$)/, route => {
    requests++;
    return failures-- > 0 ? route.abort("failed") : route.continue();
  });
  await page.reload();
  await expect(page.locator(".ProseMirror[contenteditable=true]")).toBeVisible();
  await expect(page.locator("#folio-boot")).toHaveCount(0);
  expect(requests).toBe(2);
  for (const shared of [false, true]) {
    failures = Infinity;
    requests = 0;
    await page.goto(shared ? new URL("/share?share=invalid", page.url()).href : page.url());
    const retry = page.getByRole("button", { name: "Try again", exact: true });
    await expect(page.getByRole("heading", { name: "Folio couldn't open", exact: true })).toBeVisible();
    await expect(retry).toBeVisible();
    expect(requests).toBe(2);
    if (shared) await page.unrouteAll({ behavior: "wait" });
    else {
      failures = 0;
      await retry.click();
      await expect(page.locator(".ProseMirror[contenteditable=true]")).toBeVisible();
      await expect(page.locator("#folio-boot")).toHaveCount(0);
      expect(requests).toBe(3);
    }
  }
  await page.route(/\/model\.mjs(?:\?|$)/, route => route.abort("failed"));
  await page.goto(documentUrl);
  const retry = page.getByRole("button", { name: "Try again", exact: true });
  await expect(retry).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("startup-retry-mobile-dark.png") });
  await page.unrouteAll({ behavior: "wait" });
  await retry.click();
  await expect(page.locator(".ProseMirror[contenteditable=true]")).toBeVisible();
  await expect(page.locator("#folio-boot")).toHaveCount(0);
});

test("startup mounts with already-loaded stylesheets and survives cached reloads", async ({ page }) => {
  const { origin, pathname } = new URL(page.url());
  await page.route(url => url.origin === origin && url.pathname === pathname, async route => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: (await response.text()).replaceAll('rel="preload" as="style"', 'rel="stylesheet"'),
    });
  });
  await page.reload();
  await expect(page.locator("#folio-boot")).toHaveCount(0);
  await expect(page.locator(".ProseMirror[contenteditable=true]")).toBeVisible();
  await page.unrouteAll({ behavior: "wait" });
  for (let index = 0; index < 3; index++) {
    await page.reload();
    await expect(page.locator("#folio-boot")).toHaveCount(0);
    await expect(page.locator(".ProseMirror[contenteditable=true]")).toBeVisible();
  }
});

test("shared buttons preserve icon labels, literal text and empty resize handles", async ({ page }) => {
  await page.evaluate(async () => {
    const { createButton } = await import(document.querySelector('link[href^="/editor.bundle.mjs"]').href);
    const host = document.createElement("div");
    host.id = "shared-button-test";
    host.style.cssText = "position:fixed;top:8px;left:8px;z-index:10000";
    const open = createButton({ label: "<b>Open</b>" });
    const detail = document.createElement("small");
    detail.textContent = " Project / note.md";
    open.append(detail);
    const icon = createButton({
      label: "Copy note",
      icon: "copy",
      onClick: event => { event.currentTarget.dataset.clicked = "true"; },
    });
    const handle = createButton({ label: "Resize image", text: "" });
    host.append(open, icon, handle);
    document.body.append(host);
  });
  const host = page.locator("#shared-button-test");
  try {
    const open = host.getByRole("button", { name: "<b>Open</b> Project / note.md", exact: true });
    await expect(open).toBeVisible();
    await expect(open.locator("b")).toHaveCount(0);
    const copy = host.getByRole("button", { name: "Copy note", exact: true });
    await expect(copy.locator("svg")).toHaveCount(1);
    await copy.click();
    await expect(copy).toHaveAttribute("data-clicked", "true");
    const handle = host.getByRole("button", { name: "Resize image", exact: true });
    await expect(handle).toBeEmpty();
    await expect(handle).toHaveAttribute("type", "button");
  } finally {
    await host.evaluate(node => node.remove());
  }
});

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

test("native layers preserve dialog fields and restore the nearest popup trigger on Escape", async ({ page }) => {
  const field = await page.locator("#settings-latin-font").elementHandle();
  await openSettingsDialog(page);
  await selectSettingsSection(page, "appearance");
  await page.locator("#settings-latin-font").fill("Arial");
  await page.locator("#settings-cancel").click();
  await openSettingsDialog(page);
  expect(await page.locator("#settings-latin-font").evaluate((node, previous) => node === previous, field)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.locator("#settings-dialog")).toBeHidden();
  await expect(page.locator("#more-menu > button")).toBeFocused();
  await page.locator("#more-menu > button").click();
  await expect(page.locator("#view-rich")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("#view-editor")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#more-actions-panel")).toBeHidden();
  await expect(page.locator("#more-menu > button")).toBeFocused();
});

test("native menus stay inside the resized viewport and close with their sidebar", async ({ page }) => {
  await page.locator("#new-menu > button").click();
  await expect(page.locator("#new-menu-panel")).toBeVisible();
  await page.keyboard.press(`${primaryModifier}+Shift+l`);
  await expect(page.locator("#new-menu-panel")).toBeHidden();
  await expect(page.locator("#sidebar-toggle")).toBeFocused();
  await page.locator("#more-menu > button").click();
  await page.setViewportSize({ width: 320, height: 480 });
  const menu = page.locator("#more-actions-panel");
  await expect
    .poll(async () => {
      const box = await menu.boundingBox();
      return box && box.x >= 11 && box.y >= 11 && box.x + box.width <= 309 && box.y + box.height <= 469;
    })
    .toBe(true);
  await expect(page.locator("#settings-open")).toBeInViewport();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(page.locator("#more-menu > button")).toBeFocused();
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
