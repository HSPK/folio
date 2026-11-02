import { required } from "./fixtures.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { Node, Schema } from "@milkdown/prose/model";
import { AllSelection, EditorState, NodeSelection, TextSelection } from "@milkdown/prose/state";
import { history, undo, redo } from "@milkdown/prose/history";
import { tableNodes } from "@milkdown/prose/tables";
import { blockActionTransaction, lineShortcut, richLineTransaction, textLineEdit } from "../src/line-keymap.ts";
import type { LineOperation } from "../src/line-keymap.ts";
const edit = (text: string, anchor: number, head: number, operation: LineOperation) => {
  const result = textLineEdit(text, { anchor, head }, operation);
  return (
    result && {
      ...result,
      text: result.insert === null ? text : text.slice(0, result.from) + result.insert + text.slice(result.to),
    }
  );
};
test("line moves and copies preserve Unicode, CRLF and selected line boundaries", () => {
  const text = "First\r\n中文 second\r\nThird";
  const anchor = text.indexOf("中文") + 1;
  const moved = required(edit(text, anchor, anchor, { action: "move", direction: -1 }));
  assert.equal(moved.text, "中文 second\r\nFirst\r\nThird");
  assert.equal(moved.anchor, 1);
  const copied = required(edit(moved.text, moved.anchor, moved.head, { action: "copy", direction: 1 }));
  assert.equal(copied.text, "中文 second\r\n中文 second\r\nFirst\r\nThird");
  assert.equal(copied.anchor, "中文 second\r\n".length + 1);
  const multiple = required(edit("A\nB\nC\nD", 2, 6, { action: "move", direction: -1 }));
  assert.equal(multiple.text, "B\nC\nA\nD");
  assert.equal(multiple.anchor, 0);
  assert.equal(multiple.head, 4);
});
test("deleting boundary lines and inserting indented lines keep the remaining text and caret valid", () => {
  assert.equal(required(edit("A\nB\nC", 2, 2, { action: "delete" })).text, "A\nC");
  assert.equal(required(edit("A\nB\nC", 4, 4, { action: "delete" })).text, "A\nB");
  assert.equal(required(edit("A\nB\nC", 0, 5, { action: "delete" })).text, "");
  const above = required(edit("  Alpha\nBeta", 4, 4, { action: "insert", direction: -1 }));
  assert.equal(above.text, "  \n  Alpha\nBeta");
  assert.equal(above.anchor, 2);
  const below = required(edit("  Alpha\nBeta", 4, 4, { action: "insert", direction: 1 }));
  assert.equal(below.text, "  Alpha\n  \nBeta");
  assert.equal(below.anchor, 10);
  assert.equal(edit("A\nB", 0, 0, { action: "move", direction: -1 }), null);
  const selected = required(edit("A\nB\nC", 2, 2, { action: "select" }));
  assert.equal(selected.text.slice(selected.anchor, selected.head), "B\n");
  const extended = required(edit(selected.text, selected.anchor, selected.head, { action: "select" }));
  assert.equal(extended.text.slice(extended.anchor, extended.head), "B\nC");
});
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block" },
    text: { group: "inline" },
    heading: { content: "inline*", group: "block", attrs: { level: { default: 2 } } },
    code_block: { content: "text*", group: "block", code: true, marks: "", attrs: { language: { default: "js" } } },
    blockquote: { content: "block+", group: "block" },
    hardbreak: { inline: true, group: "inline" },
    image: { inline: true, group: "inline", atom: true, attrs: { src: { default: "image.png" } } },
    image_block: {
      group: "block",
      atom: true,
      attrs: {
        src: { default: "image.png" },
        alt: { default: "" },
        width: { default: null },
        layout: { default: null },
      },
    },
    bullet_list: { content: "list_item+", group: "block" },
    ordered_list: { content: "list_item+", group: "block", attrs: { order: { default: 1 } } },
    list_item: { content: "paragraph block*", attrs: { checked: { default: null } } },
    hr: { group: "block", atom: true },
    math_block: { content: "text*", group: "block", code: true, marks: "", isolating: true },
    ...tableNodes({ tableGroup: "block", cellContent: "paragraph", cellAttributes: {} }),
  },
  marks: { strong: {}, em: {}, strike: {}, link: { attrs: { href: {}, title: { default: null } } } },
});
const paragraph = (value: string, strong = false) =>
  schema.node("paragraph", null, value ? schema.text(value, strong ? [schema.mark("strong")] : []) : []);
const document = (...nodes: Node[]) => schema.node("doc", null, nodes);
const stateAt = (doc: Node, text: string, offset = 0) => {
  let position: number | null = null;
  doc.descendants((node, at) => {
    if (node.isText && node.text === text) position = at + offset;
  });
  assert.ok(position !== null);
  return EditorState.create({ doc, selection: TextSelection.create(doc, position), plugins: [history()] });
};
test("rich block moves, copies and deletion retain formatting, selection and independent undo", () => {
  const doc = document(paragraph("Alpha", true), paragraph("Beta"), paragraph("Gamma"));
  let state = stateAt(doc, "Beta", 2);
  state = state.apply(required(richLineTransaction(state, { action: "move", direction: -1 })));
  state.doc.check();
  assert.equal(state.doc.child(0).textContent, "Beta");
  assert.equal(state.selection.$from.parentOffset, 2);
  assert.equal(state.doc.child(1).child(0).marks[0].type.name, "strong");
  state = state.apply(required(richLineTransaction(state, { action: "copy", direction: 1 })));
  assert.equal(state.doc.childCount, 4);
  assert.ok(
    undo(state, (tr) => {
      state = state.apply(tr);
    }),
  );
  assert.equal(state.doc.childCount, 3);
  assert.ok(
    undo(state, (tr) => {
      state = state.apply(tr);
    }),
  );
  assert.ok(state.doc.eq(doc));
  assert.ok(
    redo(state, (tr) => {
      state = state.apply(tr);
    }),
  );
  state = state.apply(required(richLineTransaction(state, { action: "delete" })));
  assert.equal(state.doc.textContent, "AlphaGamma");
});
test("list shortcuts move complete items and insert unchecked items without losing nested content", () => {
  const item = (text: string, checked: boolean | null = null) => schema.node("list_item", { checked }, paragraph(text));
  const doc = document(schema.node("bullet_list", null, [item("First"), item("Second", true)]));
  let state = stateAt(doc, "Second", 1);
  state = state.apply(required(richLineTransaction(state, { action: "move", direction: -1 })));
  state.doc.check();
  assert.equal(state.doc.child(0).child(0).attrs.checked, true);
  assert.equal(state.doc.child(0).child(0).textContent, "Second");
  state = state.apply(required(richLineTransaction(state, { action: "insert", direction: 1 })));
  state.doc.check();
  assert.equal(state.doc.child(0).childCount, 3);
  assert.equal(state.doc.child(0).child(1).attrs.checked, false);
  const only = document(schema.node("bullet_list", null, item("Only")));
  const removed = required(richLineTransaction(stateAt(only, "Only"), { action: "delete" }));
  removed.doc.check();
  assert.equal(removed.doc.child(0).type.name, "paragraph");
});
test("code and inline line edits preserve their container, marks and image nodes", () => {
  const code = document(schema.node("code_block", { language: "js" }, schema.text("alpha\nbeta\ngamma")));
  const moved = required(
    richLineTransaction(stateAt(code, "alpha\nbeta\ngamma", 8), { action: "move", direction: -1 }),
  );
  moved.doc.check();
  assert.equal(moved.doc.child(0).textContent, "beta\nalpha\ngamma");
  assert.equal(moved.doc.child(0).attrs.language, "js");
  const rich = document(
    schema.node("paragraph", null, [
      schema.text("Alpha", [schema.mark("strong")]),
      schema.node("hardbreak"),
      schema.node("image"),
      schema.text("Beta"),
    ]),
  );
  const reordered = required(richLineTransaction(stateAt(rich, "Beta", 1), { action: "move", direction: -1 }));
  reordered.doc.check();
  assert.equal(reordered.doc.child(0).child(0).type.name, "image");
  assert.equal(required(reordered.doc.child(0).lastChild).marks[0].type.name, "strong");
});
test("table line deletion clears content without removing required cells, and selected images stay undoable", () => {
  const cell = schema.node("table_cell", null, paragraph("Cell"));
  const table = document(schema.node("table", null, schema.node("table_row", null, cell)));
  const cleared = required(richLineTransaction(stateAt(table, "Cell", 2), { action: "delete" }));
  cleared.doc.check();
  assert.equal(cleared.doc.child(0).type.name, "table");
  assert.equal(cleared.doc.textContent, "");
  const doc = document(schema.node("image_block"), paragraph("Tail"));
  let state = EditorState.create({ doc, selection: NodeSelection.create(doc, 0), plugins: [history()] });
  state = state.apply(required(richLineTransaction(state, { action: "delete" })));
  assert.equal(state.doc.textContent, "Tail");
  assert.ok(
    undo(state, (tr) => {
      state = state.apply(tr);
    }),
  );
  assert.ok(state.doc.eq(doc));
  const selected = EditorState.create({ doc, selection: new AllSelection(doc) });
  const copied = required(richLineTransaction(selected, { action: "copy", direction: 1 }));
  copied.doc.check();
  assert.equal(copied.doc.childCount, 4);
});
test("line shortcuts do not capture composition or unrelated application chords", () => {
  assert.equal(required(lineShortcut({ key: "k", metaKey: true, shiftKey: true })).action, "delete");
  assert.deepEqual(lineShortcut({ key: "ArrowUp", altKey: true }), { action: "move", direction: -1 });
  assert.equal(lineShortcut({ key: "k", metaKey: true }), null);
  assert.equal(lineShortcut({ key: "k", metaKey: true, shiftKey: true, isComposing: true }), null);
});
test("block menu duplication and deletion retain complete code, image attributes, quote formatting and independent undo", () => {
  const nodes = [
    schema.node("code_block", { language: "rust" }, schema.text("fn main() {\n    kept();\n}")),
    schema.node("image_block", { src: "images/figure.png", alt: "Figure", width: "40%", layout: "center" }),
    schema.node("blockquote", null, [paragraph("Quote", true), paragraph("Second paragraph")]),
  ];
  for (const node of nodes) {
    const before = paragraph("Before");
    const doc = document(before, node, paragraph("After"));
    let state = stateAt(doc, "Before", 2);
    const edit = (action: string) => {
      state = state.apply(blockActionTransaction(state, { position: before.nodeSize, action }));
      state.doc.check();
    };
    edit("duplicate");
    assert.equal(state.doc.childCount, 4);
    assert.ok(state.doc.child(1).eq(node));
    assert.ok(state.doc.child(2).eq(node));
    assert.equal(state.selection.from, before.nodeSize + node.nodeSize);
    edit("delete");
    assert.equal(state.doc.childCount, 3);
    assert.equal(state.doc.child(0).textContent, "Before");
    assert.equal(required(state.doc.lastChild).textContent, "After");
    assert.ok(
      undo(state, (tr) => {
        state = state.apply(tr);
      }),
    );
    assert.equal(state.doc.childCount, 4);
    assert.ok(
      undo(state, (tr) => {
        state = state.apply(tr);
      }),
    );
    assert.ok(state.doc.eq(doc));
    state = EditorState.create({ doc: document(node) });
    state = state.apply(blockActionTransaction(state, { position: 0, action: "delete" }));
    state.doc.check();
    assert.equal(state.doc.child(0).type.name, "paragraph");
  }
});
test("a nested block menu edits that block rather than the enclosing quote or list item", () => {
  const code = schema.node("code_block", { language: "rust" }, schema.text("first\nsecond"));
  for (const container of [
    schema.node("blockquote", null, [paragraph("Before"), code, paragraph("After")]),
    schema.node(
      "bullet_list",
      null,
      schema.node("list_item", { checked: true }, [paragraph("Before"), code, paragraph("After")]),
    ),
  ]) {
    const doc = document(container);
    let position: number | undefined;
    doc.descendants((node, at) => {
      if (node === code) position = at;
    });
    assert.ok(position !== undefined);
    let state = stateAt(doc, "Before");
    state = state.apply(blockActionTransaction(state, { position, action: "duplicate" }));
    state.doc.check();
    const parent = state.doc.child(0).type.name === "blockquote" ? state.doc.child(0) : state.doc.child(0).child(0);
    assert.equal(state.doc.childCount, 1);
    assert.equal(parent.childCount, 4);
    assert.ok(parent.child(1).eq(code));
    assert.ok(parent.child(2).eq(code));
    state = state.apply(blockActionTransaction(state, { position, action: "delete" }));
    state.doc.check();
    assert.ok(state.doc.eq(doc));
  }
  const state = stateAt(document(paragraph("Text")), "Text");
  assert.throws(() => blockActionTransaction(state, { position: 1, action: "duplicate" }), /no longer editable/);
  assert.throws(() => blockActionTransaction(state, { position: -1, action: "delete" }), /no longer editable/);
  assert.throws(() => blockActionTransaction(state, { position: 0, action: "move" }), /unavailable/);
});
test("block actions preserve ordered starts, checked tasks, nested content, link marks, formulas and dividers", () => {
  const link = schema.mark("link", { href: "https://example.com/paper", title: "Paper" });
  const rich = schema.node("paragraph", null, [
    schema.text("Source", [link, schema.mark("strong")]),
    schema.text(" literal", [schema.mark("em")]),
  ]);
  const nested = schema.node("list_item", { checked: true }, [
    rich,
    schema.node("bullet_list", null, schema.node("list_item", { checked: false }, paragraph("Child"))),
  ]);
  for (const node of [
    schema.node("ordered_list", { order: 7 }, nested),
    schema.node("bullet_list", null, nested),
    schema.node("heading", { level: 3 }, rich.content),
    rich,
    schema.node("hr"),
    schema.node("math_block", null, schema.text("x^2 + y^2 = z^2")),
  ]) {
    const before = paragraph("Before");
    const doc = document(before, node, paragraph("After"));
    let state = stateAt(doc, "Before");
    state = state.apply(blockActionTransaction(state, { position: before.nodeSize, action: "duplicate" }));
    state.doc.check();
    assert.ok(state.doc.child(1).eq(node));
    assert.ok(state.doc.child(2).eq(node));
    assert.ok(
      undo(state, (tr) => {
        state = state.apply(tr);
      }),
    );
    assert.ok(state.doc.eq(doc));
  }
  const doc = document(schema.node("bullet_list", null, nested));
  let state = EditorState.create({ doc, plugins: [history()] });
  state = state.apply(blockActionTransaction(state, { position: 1, action: "duplicate" }));
  state.doc.check();
  assert.equal(state.doc.child(0).childCount, 2);
  assert.ok(state.doc.child(0).child(0).eq(nested));
  assert.ok(required(state.doc.child(0).lastChild).eq(nested));
  assert.ok(
    undo(state, (tr) => {
      state = state.apply(tr);
    }),
  );
  state = state.apply(blockActionTransaction(state, { position: 1, action: "delete" }));
  state.doc.check();
  assert.equal(state.doc.child(0).type.name, "paragraph");
  assert.ok(
    undo(state, (tr) => {
      state = state.apply(tr);
    }),
  );
  assert.ok(state.doc.eq(doc));
});
test("the block plus inserts a paragraph after the entire target without changing it and undoes in one step", () => {
  for (const node of [
    paragraph("Text", true),
    schema.node("heading", { level: 3 }, schema.text("Heading")),
    schema.node("code_block", { language: "rust" }, schema.text("first\nsecond")),
    schema.node("blockquote", null, [paragraph("Quote"), paragraph("More")]),
    schema.node("image_block", { src: "figure.png", width: "40%", layout: "center" }),
    schema.node("math_block", null, schema.text("x^2")),
    schema.node("hr"),
    schema.node("table", null, schema.node("table_row", null, schema.node("table_cell", null, paragraph("Cell")))),
  ]) {
    const before = paragraph("Before");
    const doc = document(before, node, paragraph("After"));
    let state = stateAt(doc, "Before");
    state = state.apply(blockActionTransaction(state, { position: before.nodeSize, action: "insert" }));
    state.doc.check();
    assert.ok(state.doc.child(1).eq(node));
    assert.equal(state.doc.child(2).type.name, "paragraph");
    assert.equal(state.doc.child(2).content.size, 0);
    assert.equal(state.selection.from, before.nodeSize + node.nodeSize + 1);
    assert.equal(required(state.doc.lastChild).textContent, "After");
    assert.ok(
      undo(state, (tr) => {
        state = state.apply(tr);
      }),
    );
    assert.ok(state.doc.eq(doc));
  }
});
test("the block plus adds an empty sibling list item, resets task completion and preserves nested content", () => {
  const item = schema.node("list_item", { checked: true }, [
    paragraph("Task", true),
    schema.node("bullet_list", null, schema.node("list_item", null, paragraph("Nested"))),
  ]);
  for (const type of ["bullet_list", "ordered_list"]) {
    const list = schema.node(type, type === "ordered_list" ? { order: 7 } : null, [
      item,
      schema.node("list_item", { checked: false }, paragraph("After")),
    ]);
    const doc = document(list);
    let state = EditorState.create({ doc, plugins: [history()] });
    state = state.apply(blockActionTransaction(state, { position: 1, action: "insert" }));
    state.doc.check();
    assert.ok(state.doc.child(0).child(0).eq(item));
    const added = state.doc.child(0).child(1);
    assert.equal(added.childCount, 1);
    assert.equal(added.child(0).type.name, "paragraph");
    assert.equal(added.textContent, "");
    assert.equal(added.attrs.checked, false);
    assert.equal(state.selection.$from.parent.type.name, "paragraph");
    assert.equal(required(state.doc.child(0).lastChild).textContent, "After");
    if (type === "ordered_list") assert.equal(state.doc.child(0).attrs.order, 7);
    assert.ok(
      undo(state, (tr) => {
        state = state.apply(tr);
      }),
    );
    assert.ok(state.doc.eq(doc));
  }
});
