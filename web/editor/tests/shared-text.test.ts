import test from "node:test";
import assert from "node:assert/strict";
import { createSharedText } from "../src/shared-text.ts";
import { EditorState } from "@codemirror/state";
import { history } from "@codemirror/commands";
import { historyTransaction, liveTransaction, markdownHistory } from "../src/markdown-history.ts";

test("a continued Live typing group remains separate from adjacent Source typing", () => {
  let state = EditorState.create({ doc: "A", extensions: [history()] });
  state = liveTransaction(state, "A", "AB", "group").state;
  state = liveTransaction(state, "AB", "ABC", "continue").state;
  state = state.update({ changes: { from: 3, insert: "D" }, userEvent: "input.type" }).state;
  const sourceUndo = historyTransaction(state, "undo");
  assert.equal(sourceUndo?.newDoc.toString(), "ABC");
  assert.equal(historyTransaction(sourceUndo!.state, "undo")?.newDoc.toString(), "A");
});

test("handoff replays room then solo edits in order, rebasing through a peer's identical insertion", () => {
  const solo = EditorState.create({ doc: "[]", extensions: [history()] }).update({
    changes: { from: 1, insert: "aaa" },
  }).state;
  const seed = createSharedText(() => {});
  const alice = createSharedText((update) => bob.apply(update));
  const bob = createSharedText((update) => alice.apply(update));
  try {
    seed.replace("[aaa]");
    alice.apply(seed.snapshot());
    bob.apply(seed.snapshot());
    alice.adoptSoloHistory(markdownHistory(solo));
    bob.replace("[aaXa]");
    bob.replace("[aaaa]");
    alice.replace("[aaaa]!");
    alice.undo();
    assert.equal(alice.value, "[aaaa]");
    alice.undo();
    assert.equal(bob.value, "[a]");
    alice.undo(); // nothing else by Alice
    assert.equal(bob.value, "[a]");
    alice.redo();
    assert.equal(bob.value, "[aaaa]");
    alice.redo();
    assert.equal(bob.value, "[aaaa]!");
    bob.undo(); // only Bob can remove the retained fourth 'a'
    assert.equal(alice.value, "[aaa]!");
  } finally {
    seed.destroy();
    alice.destroy();
    bob.destroy();
  }
});

test("handoff declines equal-looking text from a previously edited room", () => {
  const solo = EditorState.create({ doc: "", extensions: [history()] }).update({
    changes: { from: 0, insert: "a" },
  }).state;
  const seed = createSharedText(() => {});
  const alice = createSharedText(() => {});
  try {
    seed.replace("a");
    seed.replace("");
    seed.replace("a");
    alice.apply(seed.snapshot());
    alice.adoptSoloHistory(solo);
    alice.undo();
    assert.equal(alice.value, "a");
  } finally {
    seed.destroy();
    alice.destroy();
  }
});

test("narrow replacements preserve emoji boundaries and concurrent edits between separate changes", () => {
  const seed = createSharedText(() => {});
  const a: Uint8Array[] = [];
  const b: Uint8Array[] = [];
  const alice = createSharedText((update) => a.push(update));
  const bob = createSharedText((update) => b.push(update));
  try {
    seed.replace("😀 start | 中 | end 😀");
    alice.apply(seed.snapshot());
    bob.apply(seed.snapshot());
    alice.replace("😁 start | 中 | end 🈀");
    bob.replace("😀 start | 中文 | end 😀");
    a.forEach(bob.apply);
    b.forEach(alice.apply);
    assert.equal(alice.value, "😁 start | 中文 | end 🈀");
    assert.equal(bob.value, alice.value);
    alice.undo();
    assert.equal(alice.value, "😀 start | 中文 | end 😀");
    alice.replace("𓈀 start | 中文 | end 😀");
    assert.equal(alice.value, "𓈀 start | 中文 | end 😀");
  } finally {
    seed.destroy();
    alice.destroy();
    bob.destroy();
  }
});

test("shared Markdown merges independent edits with local-only undo and stable Unicode cursors", () => {
  const seed = createSharedText(() => {});
  const aliceUpdates: Uint8Array<ArrayBufferLike>[] = [];
  const bobUpdates: Uint8Array<ArrayBufferLike>[] = [];
  const alice = createSharedText((update) => aliceUpdates.push(update));
  const bob = createSharedText((update) => bobUpdates.push(update));
  try {
    seed.replace("---\ntitle: Shared\n---\n\n# 中文😀\n\nAlpha\n\nBeta\n");
    alice.apply(seed.snapshot());
    bob.apply(seed.snapshot());
    const cursor = bob.relative({ from: bob.value.indexOf("Beta"), to: bob.value.indexOf("Beta") });
    alice.replace(alice.value.replace("Alpha", "**Alpha**"));
    bob.replace(bob.value.replace("Beta", "Beta $x^2$"));
    for (const update of aliceUpdates.splice(0)) bob.apply(update);
    for (const update of bobUpdates.splice(0)) alice.apply(update);
    assert.equal(alice.value, bob.value);
    assert.match(alice.value, /\*\*Alpha\*\*[\s\S]*Beta \$x\^2\$/);
    const resolved = bob.resolve(cursor);
    assert.ok(resolved);
    assert.equal(resolved.to, bob.value.indexOf("Beta"));
    alice.undo();
    for (const update of aliceUpdates.splice(0)) bob.apply(update);
    assert.match(bob.value, /Alpha\n\nBeta \$x\^2\$/);
    alice.redo();
    for (const update of aliceUpdates.splice(0)) bob.apply(update);
    assert.equal(alice.value, bob.value);
    assert.match(bob.value, /\*\*Alpha\*\*/);
  } finally {
    seed.destroy();
    alice.destroy();
    bob.destroy();
  }
});
