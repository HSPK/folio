import { required } from "./fixtures.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { Node, Schema } from "@milkdown/prose/model";
import { EditorState, TextSelection, type Transaction } from "@milkdown/prose/state";
import { outdentTrailingListLine } from "../src/list-commands.ts";
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block" },
    bullet_list: { content: "list_item+", group: "block" },
    list_item: { content: "paragraph block*", attrs: { checked: { default: null } } },
    hardbreak: { inline: true, group: "inline" },
    text: { group: "inline" },
  },
});
const paragraph = (text: string, breaking = false) =>
  schema.node("paragraph", null, [
    ...(text ? [schema.text(text)] : []),
    ...(breaking ? [schema.node("hardbreak")] : []),
  ]);
const item = (text: string, breaking = false, checked: boolean | null = null) =>
  schema.node("list_item", { checked }, paragraph(text, breaking));
const list = (...items: Node[]) => schema.node("bullet_list", null, items);
for (const nested of [false, true]) {
  test(`outdenting the final visual line preserves the ${nested ? "nested" : "root"} list item`, () => {
    const original = list(item("First"), item("Last", true, false));
    const body = nested ? list(schema.node("list_item", null, [paragraph("Parent"), original])) : original;
    const doc = schema.node("doc", null, body);
    let cursor: number | undefined;
    doc.descendants((node, pos) => {
      if (node.type.name === "paragraph" && node.textContent === "Last") cursor = pos + 1 + node.content.size;
    });
    assert.ok(cursor !== undefined);
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, cursor) });
    let transaction: Transaction | undefined;
    assert.equal(
      outdentTrailingListLine(state, (next) => {
        transaction = next;
      }),
      true,
    );
    assert.ok(transaction);
    const next = state.apply(transaction);
    const retained: Node[] = [];
    next.doc.descendants((node) => {
      if (node.type.name === "list_item" && node.child(0).textContent === "Last") retained.push(node);
    });
    assert.equal(retained.length, 1);
    assert.equal(retained[0].attrs.checked, false);
    assert.equal(required(retained[0].child(0).lastChild).isText, true);
    assert.equal(next.selection.$from.parent.textContent, "");
    assert.equal(next.selection.$from.depth, nested ? 3 : 1);
  });
}
test("normal filled list items still use the standard outdent command", () => {
  const doc = schema.node("doc", null, list(item("Last")));
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, 7) });
  assert.equal(outdentTrailingListLine(state), false);
});
