import { startEditorBenchmark, statistics } from "./browser-harness.ts";
import type { CacheMode } from "./browser-benchmarks.ts";

const runCount = 8;
const formulaCount = 1024;
const formulas = [
  "E=mc^2",
  "\\int_0^1 x^2\\,dx",
  "\\sum_{n=1}^{\\infty} n^{-2}",
  "\\Vert f(x)-y\\Vert_2",
  "\\frac{\\partial L}{\\partial x}",
  "P(A\\mid B)=\\frac{P(B\\mid A)P(A)}{P(B)}",
  "\\mathbf{W}\\mathbf{x}+\\mathbf{b}",
  "\\operatorname{softmax}(z_i)",
];
const environment = await startEditorBenchmark();

async function measure(mode: CacheMode, runs?: number[]) {
  const page = await environment.browser.newPage();
  try {
    await page.goto(environment.origin);
    await page.waitForFunction(() => window.benchmarkReady === true);
    const result = await page.evaluate(({ count, mode, formulas }) => window.benchmarkCache(count, mode, formulas), {
      count: formulaCount,
      mode,
      formulas,
    });
    if (result.rendered !== formulaCount) {
      throw new Error(`Expected ${formulaCount} formulas, rendered ${result.rendered}.`);
    }
    if (runs) runs.push(result.duration);
  } finally {
    await page.close();
  }
}

try {
  await measure("repeated");
  const repeatedRuns: number[] = [];
  const uniqueRuns: number[] = [];
  const mixedRuns: number[] = [];
  for (let index = 0; index < runCount; index += 1) {
    await measure("repeated", repeatedRuns);
    await measure("unique", uniqueRuns);
    await measure("mixed", mixedRuns);
  }
  console.log(
    JSON.stringify(
      {
        formulas: formulaCount,
        repeated: statistics(repeatedRuns),
        unique: statistics(uniqueRuns),
        mixed: statistics(mixedRuns),
      },
      null,
      2,
    ),
  );
} finally {
  await environment.close();
}
