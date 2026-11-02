import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium } from "@playwright/test";

const web = fileURLToPath(new URL("..", import.meta.url));

test(
  "application remount and failed startup release owned editors, overlays and observers",
  { timeout: 60000 },
  async () => {
    const result = await build({
      configFile: path.join(web, "vite.config.ts"),
      logLevel: "silent",
      build: {
        write: false,
        rolldownOptions: { input: path.join(web, "tests/fixtures/application-lifecycle.tsx") },
      },
    });
    if (Array.isArray(result) || !("output" in result))
      throw new Error("The application fixture did not produce one build.");
    const assets = new Map(
      result.output.map((output) => [`/${output.fileName}`, output.type === "chunk" ? output.code : output.source]),
    );
    const server = createServer(async (request, response) => {
      const url = request.url ?? "/";
      try {
        if (url === "/") {
          response.setHeader("Content-Type", "text/html");
          response.end(
            '<!doctype html><meta name="folio-style-nonce" content="lifecycle-test"><link rel="stylesheet" href="/styles.css"><script type="module" src="/app.mjs"></script>',
          );
        } else if (assets.has(url)) {
          response.setHeader("Content-Type", url.endsWith(".css") ? "text/css" : "text/javascript");
          response.end(assets.get(url));
        } else if (["/model.mjs", "/workspace-model.mjs", "/editor.bundle.mjs", "/input-latency.mjs"].includes(url)) {
          response.setHeader("Content-Type", "text/javascript");
          response.end(await readFile(path.join(web, "public", url.slice(1))));
        } else {
          await new Promise((resolve) => setTimeout(resolve, 50));
          if (response.destroyed) return;
          response.setHeader("Content-Type", "application/json");
          response.writeHead(404).end(JSON.stringify({ error: "No backend is needed by the lifecycle fixture." }));
        }
      } catch (error) {
        response.writeHead(500).end(error instanceof Error ? error.message : String(error));
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const closeServer = () =>
      new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    const browser = await chromium.launch().catch(async (error) => {
      await closeServer();
      throw error;
    });
    try {
      const page = await browser.newPage();
      const failures: Error[] = [];
      page.on("pageerror", (error) => failures.push(error));
      await page.goto(`http://127.0.0.1:${address.port}`);
      await page.waitForFunction(() => Boolean(window.applicationLifecycle));
      await page.waitForSelector("body", { state: "attached" });
      await page.evaluate(() => window.applicationLifecycle.trackObservers());
      const count = () => page.evaluate(() => window.applicationLifecycle.counts());
      for (let iteration = 0; iteration < 3; iteration++) {
        await page.evaluate(() => window.applicationLifecycle.mount());
        await page.waitForSelector("#search-dialog", { state: "attached" });
        assert.deepEqual(await count(), { toolbars: 3, dialogs: 2, menus: 2, notices: 1 });
        await page.evaluate(() => window.applicationLifecycle.unmount());
        assert.deepEqual(await count(), { toolbars: 0, dialogs: 0, menus: 0, notices: 0 });
        assert.equal(
          await page.evaluate(() => window.applicationLifecycle.observers()),
          0,
          JSON.stringify(await page.evaluate(() => window.applicationLifecycle.observerDetails()), null, 2),
        );
      }
      await page.evaluate(() => window.applicationLifecycle.mount(true));
      await page.waitForSelector('[role="alert"] h1');
      assert.deepEqual(await count(), { toolbars: 0, dialogs: 0, menus: 0, notices: 0 });
      assert.equal(await page.evaluate(() => window.applicationLifecycle.observers()), 0);
      await page.evaluate(() => window.applicationLifecycle.mount());
      await page.waitForSelector("#search-dialog", { state: "attached" });
      assert.deepEqual(await count(), { toolbars: 3, dialogs: 2, menus: 2, notices: 1 });
      await page.evaluate(() => window.applicationLifecycle.unmount());
      const editors = await page.evaluate(() => window.applicationLifecycle.editors());
      assert.deepEqual(editors.afterClear, { toolbars: 3, dialogs: 2, menus: 2, notices: 0 });
      assert.equal(editors.freshSource, "# Fresh\n");
      assert.equal(editors.editable, "true");
      assert.equal(editors.failure, "Injected observer failure");
      assert.deepEqual(editors.afterDestroy, { toolbars: 0, dialogs: 0, menus: 0, notices: 0 });
      assert.equal(editors.observers, 0);
      const storage = await page.evaluate(() => window.applicationLifecycle.draftStorage());
      assert.equal(storage.source, "# Durable after close\n");
      assert.equal(storage.opened, storage.closed);
      assert.equal(storage.versionChanges, 1);
      assert.equal(storage.terminal, true);
      await new Promise((resolve) => setTimeout(resolve, 75));
      assert.deepEqual(
        failures.map((error) => error.message),
        [],
      );
    } finally {
      await browser.close();
      await closeServer();
    }
  },
);
