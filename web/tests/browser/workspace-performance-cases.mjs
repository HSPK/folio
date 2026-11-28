import { test, expect, fs, path, buildRoot, delay, userResourceId } from "./fixture.mjs";
import { collaborativeLibrary } from "./collaboration-cases.mjs";
import { addPermissionOverrides, measureClickFrame, summarizeTimings } from "./performance-helpers.mjs";
import { createHash } from "node:crypto";

test("first paint and usable note on a fresh bookmark and reload", async ({ browser, browserName }) => {
  test.skip(!process.env.FOLIO_BENCH_PAINT || browserName !== "chromium", "Opt-in navigation timing.");
  test.setTimeout(90000);
  const library = await collaborativeLibrary(browser, { participants: 1, sharing: "private" });
  try {
    const [owner] = library.pages;
    expect(new URL(owner.url()).pathname).toMatch(/^\/n\/[A-Za-z0-9_-]{8}$/);
    const cookies = await owner.context().cookies();
    const timings = {};
    for (let i = 0; i < 5; i++) {
      const context = await browser.newContext();
      try {
        await context.addCookies(cookies);
        await context.addInitScript(() => {
          window.bootTimes = {};
          function sample() {
            const now = performance.now(), times = window.bootTimes;
            if (!times.tree && document.querySelector('#file-list button[data-path="Shared.md"]')?.getClientRects().length) times.tree = now;
            if (!times.editor && document.querySelector('.ProseMirror[contenteditable="true"]')?.textContent.includes("Alpha")) times.editor = now;
            if (!times.tree || !times.editor) requestAnimationFrame(sample);
          }
          requestAnimationFrame(sample);
        });
        const page = await context.newPage();
        const cdp = await context.newCDPSession(page);
        await cdp.send("Network.enable");
        await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 80, downloadThroughput: 2_000_000, uploadThroughput: 1_000_000 });
        for (const kind of ["cold", "reload"]) {
          if (kind === "cold") await page.goto(owner.url()); else await page.reload();
          await page.waitForFunction(() => window.bootTimes.tree && window.bootTimes.editor && performance.getEntriesByName("first-contentful-paint").length);
          if (!i && process.env.FOLIO_BENCH_TRACE) console.log(kind, await page.evaluate(() => performance.getEntriesByType("resource").map(e =>
            [new URL(e.name).pathname, Math.round(e.startTime), Math.round(e.responseEnd), e.transferSize])));
          const samples = await page.evaluate(() => {
            const reads = performance.getEntriesByType("resource");
            const start = (path, suffix = "") => reads.find(e => new URL(e.name).pathname === path && e.name.includes(suffix))?.startTime;
            return { ...window.bootTimes, paint: performance.getEntriesByName("first-contentful-paint")[0].startTime,
              workspaceRequest: start("/api/workspace"), noteRequest: start("/api/document", "render=source") };
          });
          expect(samples.workspaceRequest).toBeGreaterThan(0);
          expect(samples.noteRequest).toBeGreaterThan(0);
          for (const [key, value] of Object.entries(samples)) (timings[`${kind}_${key}`] ??= []).push(Math.round(value));
        }
      } finally { await context.close(); }
    }
    console.log("PAINT", process.env.FOLIO_BENCH_PAINT, JSON.stringify(Object.fromEntries(Object.entries(timings).map(([k,v]) => [k, v.sort((a,b) => a-b)[2]]))));
  } finally { await library.close(); }
});

test("cold workspace benchmark measures first visible project, rows and editable note", async ({ browser }) => {
  test.skip(!process.env.FOLIO_BENCH_COLD, "Opt-in first-load measurement.");
  const library = await collaborativeLibrary(browser, { participants: 1, source: false, sharing: "private" });
  try {
    const [page] = library.pages;
    const lag = Number(process.env.FOLIO_BENCH_RTT_MS ?? 100);
    if (lag) await page.route(/\/(?:api\/|app\.mjs)/, async route => { await delay(lag); await route.continue(); });
    await page.addInitScript(() => {
      window.visibleAt = {};
      function sample() {
        const seen = window.visibleAt;
        const project = document.querySelector("#projects-open");
        if (!seen.project && project?.getClientRects().length && project.textContent !== "Projects") seen.project = performance.now();
        if (!seen.tree && document.querySelector('#file-list [data-path="Shared.md"]')?.getClientRects().length) seen.tree = performance.now();
        if (!seen.editor && document.querySelector('.ProseMirror[contenteditable="true"]')?.textContent.includes("Alpha")) seen.editor = performance.now();
        if (!seen.project || !seen.tree || !seen.editor) requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    });
    const timings = {};
    const bookmark = page.url();
    for (let i = 0; i < 8; ++i) {
      const kind = i % 2 ? "bookmark" : "home";
      await page.goto(i % 2 ? bookmark : new URL("/", library.url).href);
      await page.waitForFunction(() => window.visibleAt.tree && window.visibleAt.editor && window.visibleAt.project);
      for (const [metric, value] of Object.entries(await page.evaluate(() => window.visibleAt))) (timings[`${kind}_${metric}`] ??= []).push(value);
    }
    if (process.env.FOLIO_BENCH_TRACE) console.log("LAST BOOKMARK", await page.evaluate(() => performance.getEntriesByType("resource")
      .map(e => [new URL(e.name).pathname, Math.round(e.startTime), Math.round(e.responseEnd), e.transferSize])));
    for (const pointer of [false, true]) {
      const switches = timings[pointer ? "hover_click_editor" : "click_editor"] = [];
      for (let i = 0; i < 12; ++i) {
        const target = i % 2 ? "Shared" : "Other";
        if (pointer) {
          await page.locator(`button[data-path="${target}.md"]`).hover();
          await delay(230);
        }
        switches.push(await page.evaluate(name => new Promise(resolve => {
          const button = document.querySelector(`button[data-path="${name}.md"]`);
          const started = performance.now();
          button.click();
          function frame() {
            if (button.getAttribute("aria-current") === "page" &&
                document.querySelector('.ProseMirror[contenteditable="true"]')?.textContent.includes(name))
              resolve(performance.now() - started);
            else requestAnimationFrame(frame);
          }
          requestAnimationFrame(frame);
        }), target));
      }
    }
    console.log("STARTUP", process.env.FOLIO_BENCH_COLD, "added delay", lag, JSON.stringify(summarizeTimings(timings)));
  } finally { await library.close(); }
});

test("project switch benchmark measures click to usable tree across a delayed connection", async ({ browser }) => {
  test.skip(!process.env.FOLIO_BENCH_SWITCH, "Opt-in project switch measurement.");
  const library = await collaborativeLibrary(browser, { participants: 1, source: true, sharing: "private" });
  try {
    const [page] = library.pages;
    // Playwright routing disables the HTTP cache for this cold-load sample.
    await page.route("**/*.mjs", route => route.continue());
    await page.reload();
    await expect(page.locator("#editor")).toHaveValue(/Alpha/);
    const coldBytes = await page.evaluate(() => performance.getEntriesByType("resource")
      .filter(entry => /\.(mjs|css)$/.test(new URL(entry.name).pathname))
      .reduce((bytes, entry) => bytes + entry.encodedBodySize, 0));
    const created = await page.request.post(new URL("/api/projects", library.url).href, {
      data: { action: "create", name: "Second library", kind: "new" },
    });
    expect(created.ok()).toBe(true);
    const secondary = (await created.json()).id;
    const note = await page.request.post(new URL("/api/document", library.url).href, {
      headers: { "X-Folio-Project": secondary }, data: { path: "Scratch.md", content: "# Scratch\n" },
    });
    expect(note.ok()).toBe(true);
    await page.route(/\/api\/(session|tree|preferences)$/, async route => {
      await delay(100);
      await route.continue();
    });
    const times = [];
    for (let i = 0; i < 8; ++i) {
      await page.locator("#projects-open").click();
      const id = i % 2 ? "default" : secondary;
      const file = i % 2 ? "Shared.md" : "Scratch.md";
      const switcher = `.project-open[data-project="${id}"]`;
      await expect(page.locator(switcher)).toBeVisible();
      times.push((await measureClickFrame(page, switcher, `#file-list button[data-path="${file}"]`, "#file-list")).feedbackMs);
    }
    console.log("SWITCH", process.env.FOLIO_BENCH_SWITCH, coldBytes, JSON.stringify(summarizeTimings({ treeReadyMs: times })));
  } finally { await library.close(); }
});

test("workspace write benchmark distinguishes unchanged actions from real recent-note changes", async ({ browser }) => {
  test.skip(!process.env.FOLIO_BENCH_WORKSPACE_WRITES, "Opt-in workspace write measurement.");
  const library = await collaborativeLibrary(browser, { participants: 1, source: true, sharing: "private" });
  const timings = {};
  const changes = {};
  try {
    const [page] = library.pages;
    const sharedId = await userResourceId(page.context(), library.url, "Shared.md");
    const otherId = await userResourceId(page.context(), library.url, "Other.md");
    const post = async (action) => {
      const start = performance.now();
      const response = await page.request.post(new URL("/api/workspace", library.url).href, {
        data: { project: "default", id: sharedId, ...action },
      });
      expect(response.ok()).toBe(true);
      return { result: await response.json(), elapsed: performance.now() - start };
    };
    let previous = (await post({ action: "visit" })).result;
    for (const kind of ["repeatVisit", "repeatFavorite", "changedVisit"]) {
      if (kind === "repeatFavorite") previous = (await post({ action: "favorite", value: true })).result;
      timings[kind] = [];
      changes[kind] = { revisions: 0, states: 0 };
      for (let index = 0; index < 80; index += 1) {
        const action = kind === "repeatFavorite" ? { action: "favorite", value: true }
          : { action: "visit", id: kind === "changedVisit" && index % 2 === 0 ? otherId : sharedId };
        const { result, elapsed } = await post(action);
        timings[kind].push(elapsed);
        changes[kind].revisions += Number(result.revision !== previous.revision);
        changes[kind].states += Number(JSON.stringify(result.workspace) !== JSON.stringify(previous.workspace));
        previous = result;
      }
    }
    expect(changes.repeatVisit.states).toBe(0);
    expect(changes.repeatFavorite.states).toBe(0);
    expect(changes.changedVisit.states).toBe(80);
    const report = { summary: summarizeTimings(timings), changes, timings };
    await fs.mkdir(path.join(buildRoot, "workspace-write-performance"), { recursive: true });
    await fs.writeFile(path.join(buildRoot, "workspace-write-performance", `${process.env.FOLIO_BENCH_WORKSPACE_WRITES}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ summary: report.summary, changes }, null, 2));
  } finally { await library.close(); }
});

test("workspace interaction benchmark measures project navigation and search result latency", async ({ browser }) => {
  test.skip(!process.env.FOLIO_BENCH_WORKSPACE, "Opt-in workspace performance measurement.");
  const library = await collaborativeLibrary(browser, { participants: 1, source: true, sharing: "private" });
  const timings = {};
  const record = (name, value) => (timings[name] ??= []).push(value);
  const publicReads = process.env.FOLIO_BENCH_PUBLIC_READS === "1";
  const historyReads = process.env.FOLIO_BENCH_HISTORY_READS === "1";
  let guest = null;
  try {
    const [page] = library.pages;
    const document = await userResourceId(page.context(), library.url, "Shared.md");
    const body = "A paragraph about design, performance, documentation and shared editing.\n\n".repeat(460);
    for (let index = 0; index < 512; index += 1) {
      await fs.writeFile(path.join(library.notes, `Bench${String(index).padStart(4, "0")}.md`),
        `---\ntitle: Research note ${index}\ntags: [research, group-${index % 8}]\n---\n\n# Research note ${index}\n\n${body}\nUniqueNeedle${index}\n`);
    }
    const created = await page.request.post(new URL("/api/projects", library.url).href, {
      data: { action: "create", name: "Secondary project", kind: "new" },
    });
    expect(created.ok()).toBe(true);
    const secondary = (await created.json()).id;
    const note = await page.request.post(new URL("/api/document", library.url).href, {
      headers: { "X-Folio-Project": secondary },
      data: { path: "Scratch.md", content: "# Scratch\n" },
    });
    expect(note.ok()).toBe(true);
    const aclEntries = Number(process.env.FOLIO_BENCH_ACL ?? 0);
    await addPermissionOverrides(library, aclEntries);
    let publicToken = null;
    if (publicReads) {
      const shared = await page.request.post(new URL("/api/projects", library.url).href, {
        data: { action: "document", id: "default", document, permission: "publicRead",
          publicOptions: { password: "protected performance fixture password" } },
      });
      expect(shared.ok()).toBe(true);
      publicToken = (await shared.json()).publicLinks["Shared.md"].token;
      guest = await browser.newContext();
      const session = await guest.request.post(new URL("/api/public/session", library.url).href, {
        headers: { "X-Folio-Share": publicToken },
        data: { password: "protected performance fixture password" },
      });
      expect(session.ok()).toBe(true);
    }
    let historyId = null;
    if (historyReads) {
      const original = await (await page.request.get(new URL(`/api/document?id=${document}`, library.url).href)).json();
      const content = "# Archived content\n\n```text\n"
        + Array.from({ length: 16_384 }, (_, index) => createHash("sha256").update(String(index)).digest("hex")).join("\n")
        + "\n```\n";
      const archived = await page.request.put(new URL("/api/document", library.url).href, {
        data: { id: document, version: original.version, content },
      });
      expect(archived.ok()).toBe(true);
      const version = (await archived.json()).version;
      const restored = await page.request.put(new URL("/api/document", library.url).href, {
        data: { id: document, version, content: original.content },
      });
      expect(restored.ok()).toBe(true);
      const history = await (await page.request.get(new URL(`/api/history?document=${document}`, library.url).href)).json();
      historyId = history.revisions.find((revision) => revision.version === version)?.id;
      expect(Number.isSafeInteger(historyId)).toBe(true);
    }
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.locator('[data-path="Bench0511.md"]')).toBeAttached();
    const search = async () => {
      await page.locator("#more-menu > button").click();
      const result = await measureClickFrame(page, "#workspace-search-open", "#search-results button", "#search-results");
      for (const request of result.requests) {
        if (request.path === "/api/search") record("searchRequestMs", request.ms);
      }
      await expect.poll(() => page.locator("#search-message").textContent(), { timeout: 60_000 })
        .not.toMatch(/Searching|Indexing/);
      return result.feedbackMs;
    };
    let probing = true;
    let probeFailure;
    const probes = [];
    if (publicReads) probes.push({ request: guest.request, path: `/api/public/document?id=${document}`,
      headers: { "X-Folio-Share": publicToken }, metric: "indexingProtectedPublicReadMs" });
    if (historyReads) probes.push({ request: page.request, path: `/api/history/content?document=${document}&revision=${historyId}`,
      metric: "indexingHistoryContentMs" });
    if (!probes.length) probes.push({ request: page.request, path: "/api/workspace", metric: "indexingWorkspaceRequestMs" });
    const probe = (async () => {
      while (probing) {
        await Promise.all(probes.map(async (probe) => {
          const started = performance.now();
          const response = await probe.request.get(new URL(probe.path, library.url).href, { headers: probe.headers });
          expect(response.ok()).toBe(true);
          await response.body();
          record(probe.metric, performance.now() - started);
        }));
        await delay(50);
      }
    })().catch((error) => { probeFailure = error; });
    try {
      const coldStart = performance.now();
      record("coldSearchFirstResultsMs", await search());
      record("coldSearchCompleteMs", performance.now() - coldStart);
    } finally {
      probing = false;
      await probe;
      if (probeFailure) throw probeFailure;
    }
    await expect(page.locator("#search-results")).toHaveAttribute("data-virtualized", "true");
    await expect(page.locator("#search-results > li").first()).toHaveAttribute("aria-setsize", "100");
    expect(await page.locator("#search-results button").count()).toBeLessThan(100);
    await expect(page.locator("#search-tags")).toContainText("research · 512");
    await page.locator("#search-close").click();
    for (let run = 0; run < 20; run += 1) {
      record("warmSearchFirstResultsMs", await search());
      await expect(page.locator("#search-tags")).toContainText("research · 512");
      await page.locator("#search-close").click();
      const popup = await measureClickFrame(page, "#projects-open", "#projects-dialog[open]");
      record("projectsPopupFrameMs", popup.feedbackMs);
      await expect(page.locator(`[data-project="${secondary}"]`)).toBeVisible();
      const outward = await measureClickFrame(page, `[data-project="${secondary}"]`, '[data-path="Scratch.md"]', "#file-list");
      record("smallProjectTreeReadyMs", outward.feedbackMs);
      await page.locator("#projects-open").click();
      const inward = await measureClickFrame(page, '[data-project="default"]', '[data-path="Bench0000.md"]', "#file-list");
      record("largeProjectTreeReadyMs", inward.feedbackMs);
    }
    const summary = summarizeTimings(timings);
    const report = { files: 512, aclEntries, publicReads, historyReads, bodyBytes: Buffer.byteLength(body), summary, timings };
    await fs.mkdir(path.join(buildRoot, "workspace-performance"), { recursive: true });
    await fs.writeFile(path.join(buildRoot, "workspace-performance", `${process.env.FOLIO_BENCH_WORKSPACE}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ files: report.files, aclEntries, publicReads, historyReads, bodyBytes: report.bodyBytes, ...summary }, null, 2));
  } finally { await guest?.close(); await library.close(); }
});
