import {
  test, expect, openFixture, openOutline, chooseView, primaryModifier, fs, path, root, openSettingsDialog,
} from "./fixture.mjs";

const headings = ["Docker installation", "MongoDB", "neo4j", "tmux dracula"];
const source = headings.map((heading, index) =>
  `${index ? "##" : "#"} ${heading}\n\n${"A paragraph of setup instructions.\n\n".repeat(20)}`).join("");

test("mixed media benchmark measures first editable frame and scrolling through unseen blocks", async ({ page }) => {
  test.skip(!process.env.FOLIO_BENCH_MIXED, "Opt-in first-open and scrolling benchmark");
  test.setTimeout(120000);
  const files = [];
  const image = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 960;
    canvas.height = 240;
    const ctx = canvas.getContext("2d");
    for (let i = 0; i < 960; i += 4) {
      ctx.fillStyle = `hsl(${i},60%,55%)`;
      ctx.fillRect(i, 0, 4, 240);
    }
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const count = 40;
  for (let i = 0; i < count; i++) {
    const name = `images/mixed-${i}.png`;
    await fs.writeFile(path.join(root, name), Buffer.from(image, "base64"));
  }
  for (let sample = 0; sample < 5; sample++) {
    const name = `Cold mixed ${sample}`;
    files.push(name);
    const body = Array.from({length: count}, (_, i) =>
      `## Section ${i}\n\nA paragraph with **bold text** and an image.\n\n![Figure ${i}](images/mixed-${i}.png)\n\n` +
      "```js\n" + Array.from({length: 26}, (_, j) => `const value${j} = Math.max(${j}, ${i});`).join("\n") +
      "\n```\n\n| Column | Value |\n| --- | --- |\n| Status | Ready |\n\n").join("");
    await fs.writeFile(path.join(root, name + ".md"), `# ${name}\n\n${body}`);
    if (!sample) await fs.writeFile(path.join(root, "Read mixed.md"), `# Read mixed\n\n${body}`);
  }
  await page.reload();
  const loads = [], scrolls = [];
  for (const name of files) {
    const row = page.locator(`button[data-entry-path="${name}.md"]`);
    await expect(row).toHaveCount(1);
    loads.push(await row.evaluate(async (button, name) => {
      const start = performance.now();
      button.click(); // No hover prefetch; measure a first open from the tree.
      return new Promise(resolve => {
        function tick() {
          const editor = document.querySelector(".ProseMirror[contenteditable=true]");
          if (editor?.firstElementChild?.textContent === name) resolve(performance.now() - start);
          else requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
      });
    }, name));
    if (name !== files[0] && name !== files.at(-1)) continue;
    scrolls.push(await page.locator("[data-editor-scroller]").evaluate(async viewport => {
      const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
      const times = [];
      let last = await frame();
      for (let i = 0; i < 100; i++) {
        viewport.scrollTop += 135;
        const next = await frame();
        times.push(next - last);
        last = next;
      }
      return { p95: times.sort((a,b) => a-b)[94], over25ms: times.filter(ms => ms > 25).length, distance: viewport.scrollTop };
    }));
  }
  expect(scrolls.every(x => x.distance >= 13000)).toBe(true);
  await chooseView(page, "preview");
  await expect(page.locator("#preview h1")).toHaveText(files.at(-1));
  await page.locator('button[data-entry-path="Read mixed.md"]').evaluate(el => el.click());
  const pictures = page.locator("#preview img");
  await expect(page.locator("#preview h1")).toHaveText("Read mixed");
  await expect(pictures).toHaveCount(count);
  await expect.poll(() => pictures.first().evaluate(img => img.naturalWidth)).toBe(960);
  await page.waitForTimeout(300);
  const initialImages = await pictures.evaluateAll(nodes => nodes.filter(img => img.naturalWidth > 0).length);
  await pictures.last().scrollIntoViewIfNeeded();
  await expect.poll(() => pictures.last().evaluate(img => img.naturalWidth)).toBe(960);
  console.log("MIXED", JSON.stringify({loads, scrolls, initialReadImages: initialImages}));
});

test("long mixed notes highlight code on approach without moving the caret or changing Markdown", async ({ page }) => {
  const body = "# Mixed\n\n" + Array.from({length: 30}, (_, i) =>
    "```js\n" + `const id${i} = 42;\n`.repeat(45) + "```\n\n![Image](images/pixel.png)\n\n").join("");
  await openFixture(page, "Mixed highlight.md", body);
  const code = page.locator(".folio-code-block");
  await expect(code.first().locator(".folio-code-keyword").first()).toHaveText("const");
  await expect(code.last().locator(".folio-code-keyword")).toHaveCount(0);
  await page.locator(".ProseMirror h1").click();
  await page.keyboard.press("End");
  await code.last().evaluate(el => el.scrollIntoView({block: "center"}));
  await expect(code.last().locator(".folio-code-keyword")).toHaveCount(45);
  expect(await page.evaluate(() => document.getSelection()?.anchorNode?.parentElement?.closest("h1")?.textContent)).toBe("Mixed");
  await expect(page.locator("#editor")).toHaveValue(body);
});

test("long note scrolling measures frame intervals and outline work in Live and Read", async ({ page }) => {
  test.skip(!process.env.FOLIO_BENCH_SCROLL, "Opt-in scroll measurement");
  await openFixture(page, "Scroll sample.md", Array.from({length: 320}, (_, i) =>
    `## Section ${i}\n\n${"A paragraph with **formatting** and another line of text.\n\n".repeat(5)}`).join(""));
  for (const mode of ["rich", "preview"]) {
    if (mode === "preview") await chooseView(page, mode);
    const scroll = page.locator(mode === "rich" ? "[data-editor-scroller]" : "#preview");
    await expect(scroll.locator("h2[id]").last()).toHaveText("Section 319");
    if (mode === "rich") await scroll.locator("p").first().click();
    const stats = await scroll.evaluate(async viewport => {
      const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
      const rect = Element.prototype.getBoundingClientRect;
      let reads = 0, writes = 0;
      Element.prototype.getBoundingClientRect = function() {
        if (this.tagName === "H2" && viewport.contains(this)) ++reads;
        return rect.call(this);
      };
      const observer = new MutationObserver(records => { writes += records.length; });
      observer.observe(document.querySelector("#document-outline"), { attributes: true, subtree: true });
      try {
        const times = [];
        let last = await frame();
        for (let i = 0; i < 100; i++) {
          viewport.scrollTop += 24;
          const now = await frame();
          times.push(now - last);
          last = now;
        }
        const actual = viewport.scrollTop;
        times.sort((a, b) => a - b);
        return { actual, reads, writes, p95FrameMs: +times[94].toFixed(1) };
      } finally { observer.disconnect(); Element.prototype.getBoundingClientRect = rect; }
    });
    expect(stats.actual).toBeGreaterThan(2000);
    console.log("SCROLL", mode, process.env.FOLIO_BENCH_SCROLL, stats);
  }
});

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
      await expect(sidebar.getByRole("navigation", { name: "Library navigation" })).toHaveCount(0);
      await expect(sidebar.locator("#outline-tab, .sidebar-tabs")).toHaveCount(0);
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
      await page.locator("#more-menu > button").hover();
      await expect(page.locator("#outline-tab")).toHaveAttribute("aria-expanded", "false");
      await expect(panel).toBeHidden();
      expect(await panel.evaluate(node => node.inert)).toBe(true);
      await page.locator("#sidebar-hide").click();
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

test("heading position markers stay vertically centered across desktop and phone layouts", async ({ page }) => {
  await openFixture(page, "Outline-centered.md", source.replace(
    "Docker installation", "A long heading that wraps in the outline. ".repeat(8),
  ));
  if (await page.locator("#sidebar-hide").isVisible()) await page.locator("#sidebar-hide").click();
  await expect(page.locator("#outline-rail > span")).toHaveCount(4);
  for (const [width, height] of [[1440, 900], [900, 700], [650, 844], [390, 844], [390, 320]]) {
    await page.setViewportSize({ width, height });
    await expect(page.locator("#document-outline")).toBeVisible();
    await expect.poll(() => page.evaluate(() => {
      const area = document.querySelector(".document-area").getBoundingClientRect();
      const rail = document.querySelector("#outline-rail").getBoundingClientRect();
      return Math.abs(rail.y + rail.height / 2 - area.y - area.height / 2);
    })).toBeLessThan(1);
    await page.locator("#outline-tab").click();
    await expect(page.locator("#outline-panel")).toBeVisible();
    const panel = await page.locator("#outline-panel").boundingBox();
    expect(panel.y).toBeGreaterThanOrEqual(8);
    expect(panel.y + panel.height).toBeLessThanOrEqual(height - 8);
    await page.keyboard.press("Escape");
  }
});

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
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#editor")).toHaveValue(source);
});

test("Read stays on the same section when an agent inserts content above it", async ({ page }) => {
  const name = "Stable reading.md";
  await openFixture(page, name, source);
  await chooseView(page, "preview");
  const section = page.locator("#preview #neo4j");
  const offset = () => section.evaluate(node => node.getBoundingClientRect().top - node.closest("#preview").getBoundingClientRect().top);
  await section.evaluate(node => node.closest("#preview").scrollTop +=
    node.getBoundingClientRect().top - node.closest("#preview").getBoundingClientRect().top + 90);
  const before = await offset();
  await fs.writeFile(path.join(root, name), `# Added by agent\n\n${"Another paragraph.\n\n".repeat(24)}${source}`);
  await expect(page.locator("#preview #added-by-agent")).toHaveCount(1);
  await expect.poll(async () => Math.abs(await offset() - before)).toBeLessThan(2);
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
    const scrim = page.locator("#sidebar-scrim");
    await expect(scrim).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await scrim.tap({ position: { x: 375, y: 500 } });
    await expect(page.locator("#sidebar")).toBeHidden();
    await page.locator("#sidebar-toggle").tap();
    await page.locator("#sidebar-settings-open").tap();
    await expect(page.locator("#settings-dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath("navigation-touch-sidebar.png") });
    await page.locator("#sidebar-hide").tap();
    await expect(page.locator("#sidebar")).toBeHidden();
    await page.locator("#outline-tab").tap();
    await expect(page.locator("#outline-panel")).toBeVisible();
    const durations = await page.locator("#outline-panel").evaluate(node => getComputedStyle(node).transitionDuration);
    expect(durations.split(",").every(value => parseFloat(value) === 0)).toBe(true);
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
