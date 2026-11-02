import { createInlineEditor, createSourceEditor } from "../src/index.ts";
import { createCachedKatexRenderer } from "../src/katex-renderer.ts";

export type CacheMode = "repeated" | "unique" | "mixed";

const root = document.querySelector<HTMLElement>("#root");
if (!root) throw new Error("The editor benchmark needs its root element.");
const commonFormulas = Array.from({ length: 40 }, (_, index) => `x_{${index}}^2+y_{${index}}^2=z_{${index}}^2`);
const styleNonce = "folio-editor-benchmark";
let fallback = "";
let editor: ReturnType<typeof createInlineEditor> | undefined;
let sourceEditor: ReturnType<typeof createSourceEditor> | undefined;

function liveEditor() {
  if (!editor) {
    editor = createInlineEditor({
      root: benchmarkRoot(),
      onChange() {},
      onFallback(message) {
        fallback = message;
      },
      onLink() {},
      onOutline() {},
      onSelection() {},
      styleNonce,
    });
  }
  return editor;
}

function benchmarkRoot() {
  if (!root) throw new Error("The editor benchmark lost its root element.");
  return root;
}

const frames = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

function benchmarkCache(count: number, mode: CacheMode, formulas: readonly string[]) {
  const root = benchmarkRoot();
  root.replaceChildren();
  const render = createCachedKatexRenderer();
  const options = { throwOnError: false, strict: "ignore", trust: false, output: "htmlAndMathml" } as const;
  const started = performance.now();
  for (let index = 0; index < count; index += 1) {
    const output = document.createElement(index % 2 ? "span" : "div");
    root.append(output);
    const mixed = mode === "mixed";
    const cacheable = !mixed || index % 2 === 0;
    const value =
      mode === "unique"
        ? `x_{${index}}^2+y_{${index}}^2=z_{${index}}^2`
        : mixed
          ? cacheable
            ? commonFormulas[(index / 2) % commonFormulas.length]
            : `u_{${index}}^2+v_{${index}}^2=w_{${index}}^2`
          : formulas[index % formulas.length];
    render(value, output, options, mode !== "unique" && cacheable);
  }
  return { duration: performance.now() - started, rendered: root.querySelectorAll(".katex").length };
}

async function benchmarkMath(source: string, name: string) {
  const editor = liveEditor();
  fallback = "";
  const started = performance.now();
  await editor.load(source, name);
  await frames();
  if (fallback) throw new Error(fallback);
  return {
    duration: performance.now() - started,
    formulas: document.querySelectorAll('[data-type="math_inline"],[data-type="math_block"]').length,
  };
}

async function benchmarkMathEdit(count: number) {
  const editor = liveEditor();
  fallback = "";
  await editor.load("Formula $x$ tail.\n", "edit.md");
  await frames();
  if (fallback) throw new Error(fallback);
  const math = document.querySelector<HTMLElement>('[data-type="math_inline"]');
  const output = math?.querySelector(".folio-math-output");
  if (!math || !output) throw new Error("The editable benchmark formula was not rendered.");
  output.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  const editRuns: number[] = [];
  const started = performance.now();
  for (let index = 0; index < count; index += 1) {
    const editStarted = performance.now();
    if (!document.execCommand("insertText", false, String(index % 10))) {
      throw new Error("The browser rejected formula text insertion.");
    }
    await Promise.resolve();
    editRuns.push(performance.now() - editStarted);
  }
  const processedMs = performance.now() - started;
  await frames();
  const value = math.dataset.value;
  if (value === undefined) throw new Error("The edited benchmark formula lost its source value.");
  return { editRuns, processedMs, settledMs: performance.now() - started, value };
}

function benchmarkSourcePrepare(source: string, count: number) {
  if (!sourceEditor) {
    const textarea = document.createElement("textarea");
    benchmarkRoot().append(textarea);
    sourceEditor = createSourceEditor({ textarea, nonce: styleNonce });
  }
  sourceEditor.reset(source);
  const started = performance.now();
  for (let index = 0; index < count; index += 1) sourceEditor.prepare();
  return {
    duration: performance.now() - started,
    virtual: sourceEditor.isVirtual(),
    length: sourceEditor.value.length,
  };
}

declare global {
  interface Window {
    benchmarkReady: boolean;
    benchmarkCache: typeof benchmarkCache;
    benchmarkMath: typeof benchmarkMath;
    benchmarkMathEdit: typeof benchmarkMathEdit;
    benchmarkSourcePrepare: typeof benchmarkSourcePrepare;
  }
}

Object.assign(window, {
  benchmarkCache,
  benchmarkMath,
  benchmarkMathEdit,
  benchmarkSourcePrepare,
  benchmarkReady: true,
});
