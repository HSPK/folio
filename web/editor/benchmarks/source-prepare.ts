import { startEditorBenchmark, statistics } from "./browser-harness.ts";

const runCount = 10;
const prepareCount = 200;
const targetBytes = 512 * 1024;
const prefix = "# Source prepare benchmark\n\n";
// Stay below the dense-note line threshold to measure the native Source adapter.
const line = "A paragraph with English and 中文 text for UTF-8 sizing. ".repeat(4) + "\n";
const repetitions = Math.ceil((targetBytes - Buffer.byteLength(prefix)) / Buffer.byteLength(line));
const source = prefix + line.repeat(repetitions);

const environment = await startEditorBenchmark();
const runs = [];
try {
  const page = await environment.browser.newPage();
  try {
    await page.goto(environment.origin);
    await page.waitForFunction(() => window.benchmarkReady === true);
    for (let index = 0; index < runCount + 1; index += 1) {
      const result = await page.evaluate(({ source, count }) => window.benchmarkSourcePrepare(source, count), {
        source,
        count: prepareCount,
      });
      if (result.virtual) throw new Error("A 512 KiB source unexpectedly enabled CodeMirror.");
      if (result.length !== source.length) throw new Error("Source preparation changed the document.");
      if (index) runs.push(result.duration);
    }
  } finally {
    await page.close();
  }
  console.log(
    JSON.stringify(
      {
        bytes: Buffer.byteLength(source),
        prepares: prepareCount,
        total: statistics(runs),
        perPrepareMedianMs: Number((statistics(runs).medianMs / prepareCount).toFixed(4)),
      },
      null,
      2,
    ),
  );
} finally {
  await environment.close();
}
