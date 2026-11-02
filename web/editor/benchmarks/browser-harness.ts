import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { errorMessage } from "../src/errors.ts";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(packageRoot, "dist");

export function statistics(values: readonly number[]) {
  if (!values.length) throw new Error("Benchmark statistics require at least one measured run.");
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return {
    runsMs: values.map((value: number) => Number(value.toFixed(2))),
    medianMs: Number(median.toFixed(2)),
    p95Ms: Number(sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(2)),
  };
}

export async function startEditorBenchmark() {
  const { outputFiles } = await build({
    entryPoints: [path.join(packageRoot, "benchmarks/browser-benchmarks.ts")],
    outfile: "benchmark.mjs",
    bundle: true,
    format: "esm",
    target: ["es2022"],
    write: false,
    plugins: [
      {
        name: "standalone-editor",
        setup(build) {
          build.onResolve({ filter: /^\.\.\/src\/index\.ts$/ }, () => ({ path: "/editor.bundle.mjs", external: true }));
        },
      },
    ],
  });
  const harness = outputFiles[0].text;
  const server = createServer(async (request, response) => {
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self' 'nonce-folio-editor-benchmark'; " +
        "style-src-attr 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:",
    );
    try {
      const url = request.url;
      if (!url) {
        response.writeHead(400).end("Missing request URL.");
        return;
      }
      if (url === "/") {
        response.setHeader("Content-Type", "text/html");
        response.end(
          '<!doctype html><meta name="folio-style-nonce" content="folio-editor-benchmark">' +
            '<link rel="stylesheet" href="/editor.bundle.css">' +
            '<style nonce="folio-editor-benchmark">html,body,#root{height:100%;margin:0}</style>' +
            '<div id="root"></div><script type="module" src="/benchmark.mjs"></script>',
        );
      } else if (url === "/benchmark.mjs") {
        response.setHeader("Content-Type", "text/javascript");
        response.end(harness);
      } else if (["/editor.bundle.mjs", "/editor.bundle.css", "/editor-helpers.mjs"].includes(url)) {
        response.setHeader("Content-Type", url.endsWith(".css") ? "text/css" : "text/javascript");
        response.end(await readFile(path.join(publicRoot, url.slice(1))));
      } else {
        response.writeHead(404).end();
      }
    } catch (error) {
      response.writeHead(500).end(errorMessage(error));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const closeServer = () =>
    new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer();
    throw new Error("The editor benchmark did not obtain a TCP port.");
  }
  const browser = await chromium.launch({ headless: true }).catch(async (error) => {
    await closeServer();
    throw error;
  });
  return {
    browser,
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      try {
        await browser.close();
      } finally {
        await closeServer();
      }
    },
  };
}
