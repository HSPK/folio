import { startEditorBenchmark, statistics } from "./browser-harness.ts";

const runCount = 6;
const formulaCount = 528;
const repeatedFormulas = [
  "E=mc^2",
  "\\int_0^1 x^2\\,dx",
  "\\sum_{n=1}^{\\infty} n^{-2}",
  "\\Vert f(x)-y\\Vert_2",
  "\\frac{\\partial L}{\\partial x}",
  "P(A\\mid B)=\\frac{P(B\\mid A)P(A)}{P(B)}",
  "\\mathbf{W}\\mathbf{x}+\\mathbf{b}",
  "\\operatorname{softmax}(z_i)",
];

function documentSource(unique: boolean) {
  let source = "# Math rendering benchmark\n\n";
  for (let index = 0; index < 480; index += 1) {
    const formula = unique
      ? `x_{${index}}^2+y_{${index}}^2=z_{${index}}^2`
      : repeatedFormulas[index % repeatedFormulas.length];
    source += `Paragraph ${index} with $${formula}$ and surrounding text.\n\n`;
    if (index % 10 === 0) {
      const block = unique
        ? `\\sum_{j=0}^{${index + 1}} a_j`
        : repeatedFormulas[(index / 10) % repeatedFormulas.length];
      source += `$$${block}$$\n\n`;
    }
  }
  return source;
}

const environment = await startEditorBenchmark();

async function measure(source: string, name: string, runs?: number[]) {
  const page = await environment.browser.newPage();
  try {
    await page.goto(environment.origin);
    await page.waitForFunction(() => window.benchmarkReady === true);
    const result = await page.evaluate(({ source, name }) => window.benchmarkMath(source, name), { source, name });
    if (result.formulas !== formulaCount) {
      throw new Error(`Expected ${formulaCount} formulas, rendered ${result.formulas}.`);
    }
    if (runs) runs.push(result.duration);
  } finally {
    await page.close();
  }
}

try {
  const repeated = documentSource(false);
  const unique = documentSource(true);
  await measure(repeated, "warmup.md");
  const repeatedRuns: number[] = [];
  const uniqueRuns: number[] = [];
  for (let index = 0; index < runCount; index += 1) {
    await measure(repeated, `repeated-${index}.md`, repeatedRuns);
    await measure(unique, `unique-${index}.md`, uniqueRuns);
  }
  console.log(
    JSON.stringify(
      {
        formulas: formulaCount,
        repeatedBytes: Buffer.byteLength(repeated),
        uniqueBytes: Buffer.byteLength(unique),
        repeated: statistics(repeatedRuns),
        unique: statistics(uniqueRuns),
      },
      null,
      2,
    ),
  );
} finally {
  await environment.close();
}
