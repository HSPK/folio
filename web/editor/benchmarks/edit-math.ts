import { startEditorBenchmark, statistics } from "./browser-harness.ts";

const runCount = 8;
const editCount = 32;
const environment = await startEditorBenchmark();
const editRuns = [];
const processedRuns = [];
const settledRuns = [];
try {
  for (let index = 0; index < runCount + 1; index += 1) {
    const page = await environment.browser.newPage();
    try {
      await page.goto(environment.origin);
      await page.waitForFunction(() => window.benchmarkReady === true);
      const result = await page.evaluate((count) => window.benchmarkMathEdit(count), editCount);
      if (result.value.length !== editCount + 1) {
        throw new Error(`Expected ${editCount + 1} TeX characters, received ${result.value.length}.`);
      }
      if (index) {
        editRuns.push(...result.editRuns);
        processedRuns.push(result.processedMs);
        settledRuns.push(result.settledMs);
      }
    } finally {
      await page.close();
    }
  }
  console.log(
    JSON.stringify(
      {
        edits: editCount,
        perEdit: statistics(editRuns),
        processed: statistics(processedRuns),
        settled: statistics(settledRuns),
      },
      null,
      2,
    ),
  );
} finally {
  await environment.close();
}
