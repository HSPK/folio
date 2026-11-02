import { test, expect, fs, path, buildRoot, userDocumentUrl, chooseView } from "./fixture.mjs";
import { collaborativeLibrary } from "./collaboration-cases.mjs";
import { summarizeTimings } from "./performance-helpers.mjs";

test("file switching benchmark measures Markdown readiness and frame opportunity", async ({ browser, browserName }) => {
  test.skip(!process.env.FOLIO_BENCH_RUNTIME, "Opt-in file switching measurement.");
  test.setTimeout(300000);
  const library = await collaborativeLibrary(browser, { participants: 1 });
  try {
    const [page] = library.pages;
    const faults = [];
    page.on("pageerror", error => faults.push(error.message));
    const paragraph = "A paragraph with **formatted words**, a [local link](Other.md), and `inline code`.\n\n";
    const plain = paragraph.repeat(800);
    const mixed = Array.from({ length: 80 }, (_, index) => `## Section ${index}\n\n${paragraph.repeat(3)}`
      + "- [ ] A task\n- [x] A finished task\n\n| Name | Value |\n| --- | --- |\n| A | B |\n\n"
      + "```js\nconst result = values.map(value => value * 2);\n```\n\nInline $x^2 + y^2$.\n\n").join("");
    const targets = {};
    for (const [scene, body] of [["plain", plain], ["mixed", mixed]]) {
      for (const suffix of ["A", "B"]) {
        const filename = `${scene}-${suffix}.md`;
        const marker = `${scene} ${suffix}`;
        const content = suffix === "A" ? body : body.replaceAll("paragraph", "different").replaceAll("value", "entry");
        await fs.writeFile(path.join(library.notes, filename), `# ${marker}\n\n${content}`);
        targets[filename] = marker;
      }
    }
    const preferencesUrl = new URL("/api/preferences", library.url).href;
    const preferences = await (await page.request.get(preferencesUrl)).json();
    preferences.appearance.theme = "system";
    preferences.appearance.latinFont = "sans-serif";
    preferences.appearance.cjkFont = "sans-serif";
    expect((await page.request.put(preferencesUrl, { data: preferences })).ok()).toBe(true);
    await page.reload();
    await page.locator("#refresh-files").click();
    await expect(page.locator('[data-path="mixed-B.md"]')).toBeAttached();
    await page.evaluate(targets => {
      const list = document.getElementById("file-list");
      const editor = document.getElementById("rich-editor");
      list.addEventListener("pointerdown", event => {
        const button = event.target.closest("button[data-path]");
        const marker = targets[button?.dataset.path];
        if (!marker) return;
        window.fileSwitchState = {
          path: button.dataset.path, marker, start: performance.now(), trusted: event.isTrusted,
        };
      }, true);
      new MutationObserver(() => {
        const state = window.fileSwitchState;
        if (!state || state.finishing) return;
        if (list.querySelector('[aria-current="page"]')?.dataset.path !== state.path) return;
        state.feedbackMs ??= performance.now() - state.start;
        if (editor.getAttribute("aria-busy") !== "false"
            || editor.querySelector(".ProseMirror[contenteditable=true] h1")?.textContent !== state.marker) return;
        state.finishing = true;
        const readyMs = performance.now() - state.start;
        requestAnimationFrame(() => setTimeout(() => {
          if (window.fileSwitchState !== state) return;
          const heading = editor.querySelector(".ProseMirror h1");
          const visible = heading?.textContent === state.marker && heading.getBoundingClientRect().height > 0;
          const frameOpportunityMs = performance.now() - state.start;
          const request = performance.getEntriesByType("resource").filter(entry =>
            entry.startTime >= state.start && new URL(entry.name).pathname === "/api/document").at(-1);
          window.fileSwitchResult = {
            path: state.path, trusted: state.trusted, feedbackMs: state.feedbackMs, readyMs, frameOpportunityMs,
            visible,
            requestMs: request?.duration, payloadBytes: request?.decodedBodySize,
          };
        }, 0));
      }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    }, targets);
    let lastClick = 0;
    const navigate = async filename => {
      // WebKit rate-limits History API writes; pacing is outside the measured input.
      const pause = 120 - (performance.now() - lastClick);
      if (pause > 0) await new Promise(resolve => setTimeout(resolve, pause));
      await page.evaluate(() => {
        performance.clearResourceTimings();
        window.fileSwitchState = null;
        window.fileSwitchResult = null;
      });
      lastClick = performance.now();
      await page.locator(`#file-list button[data-path="${filename}"]`).click();
      try {
        await page.waitForFunction(() => window.fileSwitchResult !== null, null, { timeout: 15000 });
      } catch (error) {
        console.error(JSON.stringify({
          filename, faults,
          state: await page.evaluate(() => ({
            pending: window.fileSwitchState,
            hidden: document.hidden,
            selected: document.querySelector('#file-list [aria-current="page"]')?.dataset.path,
            view: document.getElementById("document-panes").dataset.view,
            busy: document.getElementById("rich-editor").getAttribute("aria-busy"),
            heading: document.querySelector(".ProseMirror h1")?.textContent,
            dirty: document.getElementById("dirty-indicator").dataset.state,
            notice: document.getElementById("document-message").textContent,
            dialogs: [...document.querySelectorAll("dialog[open]")].map(node => node.id),
          })),
        }));
        throw error;
      }
      const result = await page.evaluate(() => window.fileSwitchResult);
      expect(result.path).toBe(filename);
      expect(result.trusted).toBe(true);
      expect(result.visible).toBe(true);
      expect(Number.isFinite(result.requestMs)).toBe(true);
      return result;
    };
    const timings = {};
    const cold = {};
    for (const scene of ["plain", "mixed"]) {
      cold[scene] = [await navigate(`${scene}-A.md`), await navigate(`${scene}-B.md`)];
      for (let index = 0; index < 120; index += 1) {
        const result = await navigate(`${scene}-${index % 2 ? "B" : "A"}.md`);
        for (const key of ["feedbackMs", "readyMs", "frameOpportunityMs", "requestMs"]) {
          (timings[`${scene}-${key}`] ??= []).push(result[key]);
        }
      }
    }
    const directory = path.join(buildRoot, "runtime-performance");
    await fs.mkdir(directory, { recursive: true });
    if (process.env.FOLIO_BENCH_PROFILE) {
      if (browserName !== "chromium") throw new Error("CPU profiling requires the Chrome benchmark.");
      const profiler = await page.context().newCDPSession(page);
      await profiler.send("Profiler.enable");
      await profiler.send("Profiler.start");
      for (let index = 0; index < 8; index += 1) await navigate(`mixed-${index % 2 ? "B" : "A"}.md`);
      const { profile } = await profiler.send("Profiler.stop");
      await fs.writeFile(path.join(directory, `${process.env.FOLIO_BENCH_RUNTIME}-file-layout.cpuprofile`), JSON.stringify(profile));
      await profiler.detach();
    }
    const summary = summarizeTimings(timings);
    const report = {
      browser: browserName, plainBytes: Buffer.byteLength(plain), mixedBytes: Buffer.byteLength(mixed),
      summary, cold, timings,
    };
    await fs.writeFile(path.join(directory, `${process.env.FOLIO_BENCH_RUNTIME}-file-layout.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, timings: undefined }, null, 2));
    if (browserName !== "webkit") {
      await page.locator(".folio-code-scroll").first().hover();
      await page.screenshot({ path: test.info().outputPath("mixed-layout-light.png"), caret: "initial" });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.screenshot({ path: test.info().outputPath("mixed-layout-dark.png"), caret: "initial" });
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath("mixed-layout-narrow.png"), caret: "initial" });
    }
  } finally { await library.close(); }
});

test("outline navigation benchmark measures trusted warm and after-edit jumps", async ({ browser, browserName }) => {
  test.skip(!process.env.FOLIO_BENCH_RUNTIME, "Opt-in outline measurement.");
  test.setTimeout(180000);
  const library = await collaborativeLibrary(browser, { participants: 1 });
  try {
    const [page] = library.pages;
    const headingCount = 512;
    const paragraph = "A paragraph for measuring direct navigation without rebuilding a source map. ".repeat(2) + "\n\n";
    const source = "---\ntitle: Outline benchmark\n---\n\n"
      + Array.from({ length: headingCount }, (_, index) => `## Heading ${index}\n\n${paragraph.repeat(4)}`).join("");
    await fs.writeFile(path.join(library.notes, "Outline-benchmark.md"), source);
    const preferencesUrl = new URL("/api/preferences", library.url).href;
    const preferences = await (await page.request.get(preferencesUrl)).json();
    preferences.appearance.latinFont = "sans-serif";
    preferences.appearance.cjkFont = "sans-serif";
    expect((await page.request.put(preferencesUrl, { data: preferences })).ok()).toBe(true);
    await page.goto(await userDocumentUrl(page.context(), library.url, "Outline-benchmark.md"));
    await expect(page.locator(".ProseMirror[contenteditable=true]")).toBeVisible();
    await page.locator("#outline-tab").click();
    await expect(page.locator("#outline-list button")).toHaveCount(headingCount);
    await page.locator(".ProseMirror > p").first().click();
    await page.evaluate(() => {
      const outline = document.getElementById("outline-list");
      const targets = [...document.querySelectorAll(".ProseMirror h2")];
      let start = 0;
      outline.addEventListener("click", () => { start = performance.now(); }, true);
      outline.addEventListener("click", event => {
        const button = event.target.closest("button[data-heading]");
        if (!button) return;
        const dispatchMs = performance.now() - start;
        const target = targets[Number(button.dataset.heading)];
        const began = start;
        requestAnimationFrame(() => setTimeout(() => {
          const frameOpportunityMs = performance.now() - began;
          const rect = target.getBoundingClientRect();
          const viewport = target.closest(".folio-live-scroll").getBoundingClientRect();
          window.outlineTimingResult = {
            dispatchMs, frameOpportunityMs, trusted: event.isTrusted,
            visible: rect.bottom > viewport.top && rect.top < viewport.bottom,
          };
        }, 0));
      });
    });
    const timings = {};
    for (const scene of ["warm", "afterEdit"]) {
      for (let index = 0; index < 120; index += 1) {
        if (scene === "afterEdit") {
          await page.locator(".ProseMirror > p").last().click();
          await page.keyboard.insertText("x");
        }
        await page.evaluate(() => { window.outlineTimingResult = null; });
        const heading = (511 + index * 137) % headingCount;
        await page.locator(`#outline-list button[data-heading="${heading}"]`).click();
        await page.waitForFunction(() => window.outlineTimingResult !== null);
        const measured = await page.evaluate(() => window.outlineTimingResult);
        expect(measured.trusted).toBe(true);
        expect(measured.visible).toBe(true);
        (timings[`${scene}DispatchMs`] ??= []).push(measured.dispatchMs);
        (timings[`${scene}FrameOpportunityMs`] ??= []).push(measured.frameOpportunityMs);
      }
    }
    const summary = summarizeTimings(timings);
    const directory = path.join(buildRoot, "runtime-performance");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, `${process.env.FOLIO_BENCH_RUNTIME}-outline.json`), JSON.stringify({
      browser: browserName, bytes: Buffer.byteLength(source), headings: headingCount, summary, timings,
    }, null, 2));
    console.log(JSON.stringify({ browser: browserName, bytes: Buffer.byteLength(source), headings: headingCount, summary }, null, 2));
  } finally { await library.close(); }
});

test("input diagnostics are opt-in and never include note text", async ({ page }) => {
  const requests = [];
  page.on("request", request => requests.push(new URL(request.url()).pathname));
  await page.reload();
  await expect(page.locator(".ProseMirror[contenteditable=true]")).toBeVisible();
  expect(await page.evaluate(() => typeof window.folioPerformance)).toBe("undefined");
  expect(requests).not.toContain("/input-latency.mjs");
  const url = new URL(page.url());
  url.searchParams.set("perf", "1");
  await page.goto(url.href);
  await expect(page.locator(".ProseMirror[contenteditable=true]")).toBeVisible();
  await page.waitForFunction(() => Boolean(window.folioPerformance));
  await page.evaluate(() => window.folioPerformance.reset());
  await page.locator(".ProseMirror p").first().click();
  await page.keyboard.type("private_latency_probe");
  await page.waitForFunction(() => {
    const report = window.folioPerformance.report();
    return report.samples >= 21 && Object.values(report.groups)
      .some(group => group.inputToFrameOpportunity.count >= 21);
  });
  const report = await page.evaluate(() => window.folioPerformance.report());
  expect(report.recording).toBe(true);
  expect(report.samples).toBeGreaterThanOrEqual(21);
  expect(Object.values(report.groups)[0].inputToModel.count).toBeGreaterThan(0);
  expect(JSON.stringify(report)).not.toMatch(/private_latency_probe|README\.md|127\.0\.0\.1|a \*\*local\*\*/i);
  await page.evaluate(() => window.folioPerformance.stop());
  const count = (await page.evaluate(() => window.folioPerformance.report())).samples;
  await page.keyboard.type("ignored");
  expect((await page.evaluate(() => window.folioPerformance.report())).samples).toBe(count);
});

test("runtime benchmark measures cold loading and Live and large Source input", async ({ browser }) => {
  test.skip(!process.env.FOLIO_BENCH_RUNTIME, "Opt-in runtime measurement.");
  test.setTimeout(180000);
  const shared = Boolean(process.env.FOLIO_BENCH_RUNTIME_SHARED);
  const library = await collaborativeLibrary(browser, { participants: shared ? 2 : 1 });
  try {
    const [page] = library.pages;
    const timings = {};
    const record = (name, value) => (timings[name] ??= []).push(value);
    const paragraph = "A paragraph with **formatted words**, a [local link](Other.md), and `inline code`.\n\n";
    const medium = "# Runtime document\n\n" + paragraph.repeat(800);
    const large = "# Large Source document\n\n" + paragraph.repeat(13500);
    await fs.writeFile(path.join(library.notes, "Runtime.md"), medium);
    await fs.writeFile(path.join(library.notes, "Runtime-source.md"), large);
    const preferencesUrl = new URL("/api/preferences", library.url).href;
    const preferences = await (await page.request.get(preferencesUrl)).json();
    preferences.appearance.latinFont = "sans-serif";
    preferences.appearance.cjkFont = "sans-serif";
    expect((await page.request.put(preferencesUrl, { data: preferences })).ok()).toBe(true);
    const url = await userDocumentUrl(page.context(), library.url, "Runtime.md");
    await page.addInitScript(() => {
      window.runtimeReadyMs = null;
      const observer = new MutationObserver(() => {
        const editor = document.querySelector(".ProseMirror[contenteditable=true]");
        if (!editor || !editor.getClientRects().length
            || document.querySelector("#rich-editor")?.getAttribute("aria-busy") !== "false") return;
        window.runtimeReadyMs = performance.now();
        observer.disconnect();
      });
      observer.observe(document, { subtree: true, attributes: true, childList: true });
    });
    const profiler = await page.context().newCDPSession(page);
    await profiler.send("Network.enable");
    await profiler.send("Network.setCacheDisabled", { cacheDisabled: true });
    await profiler.send("Profiler.enable");
    await profiler.send("Profiler.start");
    for (let index = 0; index < 6; index += 1) {
      await page.goto(url);
      await page.waitForFunction(() => window.runtimeReadyMs !== null);
      record("coldLiveReadyMs", await page.evaluate(() => window.runtimeReadyMs));
    }
    const { profile: startupProfile } = await profiler.send("Profiler.stop");
    if (shared) {
      await library.pages[1].goto(url);
      for (const participant of library.pages) await expect(participant.locator("#collaboration-join")).toHaveAttribute("aria-pressed", "true");
    }
    await profiler.send("Profiler.start");
    const measureInput = async (selector, name) => {
      const editor = page.locator(selector);
      await editor.waitFor({ state: "visible" });
      await editor.focus();
      if (selector === ".ProseMirror") await editor.locator("p").last().click();
      await page.evaluate(selector => {
        const editor = document.querySelector(selector);
        editor.addEventListener("beforeinput", () => { window.runtimeInputStart = performance.now(); }, true);
        document.getElementById("editor").addEventListener("input", () => {
          if (!window.runtimeInputPending) return;
          window.runtimeInputPending = false;
          const dispatchMs = performance.now() - window.runtimeInputStart;
          requestAnimationFrame(() => setTimeout(() => {
            window.runtimeInputResult = { dispatchMs, frameOpportunityMs: performance.now() - window.runtimeInputStart };
          }, 0));
        });
      }, selector);
      for (let index = 0; index < 120; index += 1) {
        await page.evaluate(() => { window.runtimeInputResult = null; window.runtimeInputPending = true; });
        const started = performance.now();
        await page.keyboard.insertText(index % 2 ? "x" : "y");
        await page.waitForFunction(() => window.runtimeInputResult !== null, null, { timeout: 10000 });
        const measured = await page.evaluate(() => window.runtimeInputResult);
        expect(Number.isFinite(measured.dispatchMs)).toBe(true);
        record(`${name}DispatchMs`, measured.dispatchMs);
        record(`${name}FrameOpportunityMs`, measured.frameOpportunityMs);
        if (shared && selector === ".ProseMirror") {
          await expect(library.pages[1].locator("#editor")).toHaveValue(await page.locator("#editor").inputValue());
          record(`${name}RemoteMs`, performance.now() - started);
        }
      }
    };
    await measureInput(".ProseMirror", "liveInput");
    await page.locator("#outline-tab").click();
    await measureInput(".ProseMirror", "outlineInput");
    await page.keyboard.press("Control+s");
    await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    await page.locator("#files-tab").click();
    await chooseView(page, "editor");
    await page.locator('#file-list button[data-path="Runtime-source.md"]').click();
    await measureInput(".virtual-source-editor .cm-content", "sourceInput");
    const { profile } = await profiler.send("Profiler.stop");
    await profiler.detach();
    const summary = summarizeTimings(timings);
    const directory = path.join(buildRoot, "runtime-performance");
    await fs.mkdir(directory, { recursive: true });
    const label = process.env.FOLIO_BENCH_RUNTIME;
    await fs.writeFile(path.join(directory, `${label}.cpuprofile`), JSON.stringify(profile));
    await fs.writeFile(path.join(directory, `${label}-startup.cpuprofile`), JSON.stringify(startupProfile));
    await fs.writeFile(path.join(directory, `${label}.json`), JSON.stringify({
      liveBytes: Buffer.byteLength(medium), sourceBytes: Buffer.byteLength(large), summary, timings,
    }, null, 2));
    await page.screenshot({ path: test.info().outputPath(`${label}-source.png`), animations: "disabled" });
    console.log(JSON.stringify({ liveBytes: Buffer.byteLength(medium), sourceBytes: Buffer.byteLength(large), summary }, null, 2));
  } finally { await library.close(); }
});
