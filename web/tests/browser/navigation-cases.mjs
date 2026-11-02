import {
  test, expect, openFixture, openOutline, chooseView, primaryModifier, fs, path, root, openSettingsDialog,
} from "./fixture.mjs";

const headings = ["Docker installation", "MongoDB", "neo4j", "tmux dracula"];
const source = headings.map((heading, index) =>
  `${index ? "##" : "#"} ${heading}\n\n${"A paragraph of setup instructions.\n\n".repeat(20)}`).join("");

test("opening notes and saving settings never exposes or polls retired Git features", async ({ page }) => {
  const requests = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname.startsWith("/api/git")) requests.push(request.url());
  });
  await page.reload();
  await expect(page.locator(".ProseMirror")).toBeVisible();
  await expect(page.locator('#git-tab, #git-panel, #git-diff-dialog, [id^="settings-git-"]')).toHaveCount(0);
  await openSettingsDialog(page, { section: "layout" });
  expect(await page.locator("#settings-default-sidebar option").evaluateAll(nodes => nodes.map(node => node.value)))
    .toEqual(["files", "outline"]);
  await page.locator("#settings-save").click();
  await expect(page.locator("#settings-dialog")).toBeHidden();
  await page.locator(".ProseMirror > p").first().click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" Kept editing.");
  await expect(page.locator(".ProseMirror")).toContainText("Kept editing.");
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(page.locator(".ProseMirror")).not.toContainText("Kept editing.");
  expect(requests).toEqual([]);
});

for (const theme of ["light", "dark"]) {
  test(`sidebar navigation and right outline match the compact hover design in ${theme}`, async ({ page, browserName }) => {
    await page.emulateMedia({ colorScheme: theme });
    const folder = path.join(root, "Navigation examples");
    await fs.mkdir(folder, { recursive: true });
    try {
      await fs.writeFile(path.join(folder, "Installation.md"), "# Installation\n");
      await fs.writeFile(path.join(folder, "Reference.md"), "# Reference\n");
      await openFixture(page, `Navigation-${theme}.md`, source);
      const sidebar = page.locator("#sidebar");
      const outline = page.locator("#document-outline");
      const panel = page.locator("#outline-panel");
      await expect(sidebar.getByRole("navigation", { name: "Library navigation" })).toBeVisible();
      await expect(sidebar.locator("#outline-tab, .sidebar-tabs")).toHaveCount(0);
      await expect(page.locator("#files-tab")).toHaveAttribute("aria-pressed", "true");
      await expect(outline).toBeVisible();
      await expect(panel).toBeHidden();
      await expect(page.locator("#outline-rail > span")).toHaveCount(4);
      const editorBounds = await page.locator(".folio-live-scroll").boundingBox();
      const outlineBounds = await outline.boundingBox();
      expect(outlineBounds.x).toBeGreaterThan(editorBounds.x + editorBounds.width - 60);
      if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath(`navigation-${theme}-compact.png`) });
      await page.locator("#outline-tab").hover();
      await expect(panel).toBeVisible();
      await expect(panel).toHaveCSS("opacity", "1");
      await expect(page.locator("#outline-list button")).toHaveText(headings);
      expect(await page.locator(".folio-live-scroll").boundingBox()).toEqual(editorBounds);
      if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath(`navigation-${theme}-hover.png`) });
      await panel.hover();
      await expect(panel).toBeVisible();
      await page.locator(".document-header").hover();
      await expect(page.locator("#outline-tab")).toHaveAttribute("aria-expanded", "false");
      await expect(panel).toBeHidden();
      expect(await panel.evaluate(node => node.inert)).toBe(true);
      await page.locator("#sidebar-toggle").click();
      await expect(sidebar).toBeHidden();
      await openOutline(page);
      await page.locator("#outline-list").getByRole("button", { name: "neo4j", exact: true }).click();
      await expect(page.locator(".ProseMirror #neo4j")).toBeInViewport();
      await expect(page.locator(".ProseMirror")).toBeFocused();
      await expect(page.locator('#outline-list [aria-current="location"]')).toHaveText("neo4j");
      await expect(page.locator("#editor")).toHaveValue(source);
    } finally { await fs.rm(folder, { recursive: true, force: true }); }
  });
}

test("right outline follows reading position and supports keyboard dismissal without editing", async ({ page }) => {
  await openFixture(page, "Outline-keyboard.md", source);
  const target = page.locator(".ProseMirror #neo4j");
  await target.evaluate(node => {
    const scroll = node.closest("[data-editor-scroller]");
    scroll.scrollTop += node.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 30;
  });
  await expect(page.locator("#outline-rail > .is-current")).toHaveAttribute("data-heading", "2");
  const trigger = page.locator("#outline-tab");
  await trigger.focus();
  await expect(page.locator("#outline-panel")).toBeVisible();
  await trigger.press("ArrowDown");
  await expect(page.locator("#outline-list").getByRole("button", { name: "neo4j", exact: true })).toBeFocused();
  await page.keyboard.press("Home");
  await expect(page.locator("#outline-list button").first()).toBeFocused();
  await page.keyboard.press("End");
  await expect(page.locator("#outline-list button").last()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#outline-panel")).toBeHidden();
  await page.keyboard.press(`${primaryModifier}+Shift+1`);
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#files-tab")).toHaveAttribute("aria-pressed", "true");
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#editor")).toHaveValue(source);
});

test("right outline keeps all headings, stable labels and precise navigation in Source and Read", async ({ page }) => {
  await openFixture(page, "Outline-all-headings.md", Array.from({ length: 80 }, (_, index) =>
    `## Heading ${index}\n\nParagraph.\n\n`).join(""));
  await expect(page.locator("#outline-rail > span")).toHaveCount(24);
  await openOutline(page);
  await expect(page.locator("#outline-list button")).toHaveCount(80);
  await chooseView(page, "editor");
  await openOutline(page);
  await page.locator("#outline-list").getByRole("button", { name: "Heading 79", exact: true }).click();
  expect(await page.locator("#editor").evaluate(node => node.selectionStart)).toBe(
    (await page.locator("#editor").inputValue()).lastIndexOf("## Heading 79"));
  await chooseView(page, "preview");
  await openOutline(page);
  await page.locator("#outline-list").getByRole("button", { name: "Heading 0", exact: true }).click();
  await expect(page.locator("#preview #heading-0")).toBeInViewport();
  await chooseView(page, "editor");
  const original = await page.locator("#outline-list button").first().elementHandle();
  await page.locator("#editor").fill("# Renamed heading\n\nBody.\n");
  await expect(page.locator("#outline-rail > span")).toHaveCount(1);
  await page.locator("#editor").fill("# Updated heading\n\nBody.\n");
  await expect(page.locator("#outline-list button")).toHaveText("Updated heading");
  expect(await original.evaluate(node => node.isConnected)).toBe(false);
  const stable = await page.locator("#outline-list button").first().elementHandle();
  await page.locator("#editor").fill("# Latest heading\n\nBody.\n");
  await expect(page.locator("#outline-list button")).toHaveText("Latest heading");
  expect(await stable.evaluate(node => node.isConnected)).toBe(true);
  await page.locator("#editor").fill("No headings in this note.\n");
  await expect(page.locator("#document-outline")).toBeHidden();
});

test.describe("touch outline", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test("sidebar and tap-open outline remain usable on a narrow screen with reduced motion", async ({ page, browserName }) => {
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await openFixture(page, "Navigation-touch.md", source);
    await page.locator("#sidebar-toggle").tap();
    await expect(page.locator("#sidebar")).toBeVisible();
    await page.locator("#sidebar-settings-open").tap();
    await expect(page.locator("#settings-dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath("navigation-touch-sidebar.png") });
    await page.locator("#sidebar-hide").tap();
    await expect(page.locator("#sidebar")).toBeHidden();
    await page.locator("#outline-tab").tap();
    await expect(page.locator("#outline-panel")).toBeVisible();
    await expect(page.locator("#outline-panel")).toHaveCSS("transition-duration", "0s, 0s");
    const panel = await page.locator("#outline-panel").boundingBox();
    expect(panel.x).toBeGreaterThanOrEqual(0);
    expect(panel.x + panel.width).toBeLessThanOrEqual(390);
    if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath("navigation-touch-outline.png") });
    await page.locator("#outline-list").getByRole("button", { name: "MongoDB", exact: true }).tap();
    await expect(page.locator(".ProseMirror #mongodb")).toBeInViewport();
    await expect(page.locator("#outline-panel")).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator("#editor")).toHaveValue(source);
  });
});
