import assert from "node:assert/strict";
import test from "node:test";
import { DocInput, StreamLanguage } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { highlightTree } from "@lezer/highlight";
import { codeFileMode, codeFileParser } from "../src/code-syntax.ts";
import { codeTokenStyle } from "../src/code-token-style.ts";

test("viewport token offsets keep multiline Rust context after an edit above the viewport", () => {
  const parser = codeFileParser("rs");
  assert.ok(parser);
  const prefix = "let a = 1;\n".repeat(100);
  let state = EditorState.create({ doc: prefix + "/*\nfn inside\n*/\nfn outside() {}\n" + prefix });
  const visible = () => {
    const from = state.doc.line(102).from,
      to = state.doc.line(104).to;
    const work = parser.start(new DocInput(state.doc), to);
    let tree;
    while (!(tree = work.advance())) {
      /* Finish this viewport parse. */
    }
    parser.remember(tree, true);
    const spans: [string, string][] = [];
    parser.tokens(tree, from, to, (a, b, cls) => spans.push([state.sliceDoc(a, b), cls]));
    return spans;
  };
  assert.ok(visible().some(([text, cls]) => text.includes("fn inside") && cls === "folio-code-comment"));
  const from = prefix.length;
  state = state.update({ changes: { from, to: from + 2, insert: "//" } }).state;
  parser.changed([{ fromA: from, toA: from + 2, fromB: from, toB: from + 2 }]);
  assert.deepEqual(visible()[0], ["fn", "folio-code-keyword"]);
});

test("file modes distinguish Python, SQL and component markup rather than coloring generic words", () => {
  for (const [ext, input, token] of [
    ["py", 'def read():\n  """multi\nline"""\n', "def"],
    ["sql", "SELECT title FROM files", "SELECT"],
    ["vue", '<Widget title="sample" />', "Widget"],
  ]) {
    const mode = codeFileMode(ext);
    assert.ok(mode);
    const spans: string[] = [];
    highlightTree(StreamLanguage.define(mode).parser.parse(input), codeTokenStyle, (a, b) =>
      spans.push(input.slice(a, b)),
    );
    assert.ok(spans.includes(token), `${ext}: ${spans.join(", ")}`);
  }
  assert.equal(codeFileMode("constructor"), undefined);
  assert.equal(codeFileParser("constructor"), undefined);
});
