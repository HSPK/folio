import { required, selectedNode } from "./fixtures.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { Node, Schema } from "@milkdown/prose/model";
import { EditorState, NodeSelection, TextSelection } from "@milkdown/prose/state";
import { GapCursor } from "@milkdown/prose/gapcursor";
import { history, undo, redo } from "@milkdown/prose/history";
import { liftListItem, sinkListItem, splitListItem } from "@milkdown/prose/schema-list";
import { imageKeyTransaction } from "../src/image-flow.ts";
import { currentViewSelection } from "../src/cursor-coordinates.ts";
import {
  imageInsertionTransaction,
  imageLayoutTransaction,
  imageMoveTransaction,
  imageRemovalTransaction,
  imageRowCount,
  imageRowNeighbor,
  imageRowTarget,
  imageRowTransaction,
  isImageNode,
} from "../src/image-model.ts";
const attrs = {
  src: { default: "" },
  alt: { default: "" },
  title: { default: "" },
  width: { default: null },
  height: { default: null },
  layout: { default: "inline" },
  explicitInline: { default: false },
};
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block" },
    text: { group: "inline" },
    image: { inline: true, group: "inline", atom: true, attrs },
    image_block: { group: "block", atom: true, attrs },
    blockquote: { content: "block+", group: "block" },
    bullet_list: { content: "list_item+", group: "block" },
    list_item: { content: "(paragraph | image_block) block*" },
    table: { content: "table_cell+", group: "block" },
    table_cell: { content: "paragraph" },
  },
});
const image = (alt: string, layout = "left") =>
  schema.node(layout === "inline" ? "image" : "image_block", { src: `${alt}.png`, alt, layout, width: "200" });
const paragraph = (...content: (string | Node)[]) =>
  schema.node(
    "paragraph",
    null,
    content.map((value) => (typeof value === "string" ? schema.text(value) : value)),
  );
const document = (...content: Node[]) => schema.node("doc", null, content);
const images = (doc: Node) => {
  const values: Node[] = [];
  doc.descendants((node) => {
    if (isImageNode(node)) values.push(node);
  });
  return values;
};
const selectedState = (doc: Node, position = 0) =>
  EditorState.create({ doc, selection: NodeSelection.create(doc, position), plugins: [history()] });
test("block image arrows use native gaps at document edges and text selections beside paragraphs without editing", () => {
  const only = document(image("First"));
  const state = selectedState(only);
  for (const [key, position] of [
    ["ArrowLeft", 0],
    ["ArrowRight", 1],
    ["ArrowUp", 0],
    ["ArrowDown", 1],
  ] as const) {
    const transaction = required(imageKeyTransaction(state, key));
    assert.equal(transaction.doc, only);
    assert.equal(transaction.docChanged, false);
    assert.ok(transaction.selection instanceof GapCursor);
    assert.equal(transaction.selection.head, position);
  }
  const doc = document(paragraph("Before"), image("First"), paragraph("After"));
  const next = required(imageKeyTransaction(selectedState(doc, 8), "ArrowRight"));
  assert.ok(next.selection instanceof TextSelection);
  assert.equal(next.selection.head, 10);
});
test("Enter after a selected block or native gap creates a real editable paragraph in one undoable change", () => {
  for (const gap of [false, true]) {
    const doc = document(image("First"), image("Second"));
    let state = selectedState(doc);
    if (gap) state = state.apply(required(imageKeyTransaction(state, "ArrowRight")));
    state = state.apply(required(imageKeyTransaction(state, "Enter")));
    state.doc.check();
    assert.equal(state.doc.childCount, 3);
    assert.equal(state.doc.child(1).type.name, "paragraph");
    assert.ok(state.selection instanceof TextSelection);
    assert.equal(state.selection.head, 2);
    assert.equal(state.doc.textContent, "");
    assert.ok(
      undo(state, (transaction) => {
        state = state.apply(transaction);
      }),
    );
    assert.ok(state.doc.eq(doc));
    assert.ok(
      redo(state, (transaction) => {
        state = state.apply(transaction);
      }),
    );
    assert.equal(state.doc.child(1).type.name, "paragraph");
  }
});
test("inline image arrows and Enter preserve the image and surrounding text", () => {
  const doc = document(paragraph("A", image("Inline", "inline"), "B"));
  const state = selectedState(doc, 2);
  assert.equal(required(imageKeyTransaction(state, "ArrowLeft")).selection.head, 2);
  assert.equal(required(imageKeyTransaction(state, "ArrowRight")).selection.head, 3);
  const entered = state.apply(required(imageKeyTransaction(state, "Enter")));
  entered.doc.check();
  assert.equal(images(entered.doc).length, 1);
  assert.equal(entered.doc.childCount, 2);
  assert.equal(entered.doc.child(0).textContent, "A");
  assert.equal(entered.doc.child(1).textContent, "B");
  assert.equal(entered.selection.head, 5);
});
test("changing inline layout splits the textblock without losing text, attributes or undo history", () => {
  const doc = document(paragraph("Before", image("Inline", "inline"), "After"));
  let state = selectedState(doc, 7);
  state = state.apply(imageLayoutTransaction(state, { position: 7, attrs: { layout: "center", width: "50%" } }));
  state.doc.check();
  assert.deepEqual(
    Array.from({ length: state.doc.childCount }, (_, index) => state.doc.child(index).type.name),
    ["paragraph", "image_block", "paragraph"],
  );
  assert.equal(state.doc.textContent, "BeforeAfter");
  assert.equal(selectedNode(state.selection).attrs.width, "50%");
  assert.equal(selectedNode(state.selection).attrs.alt, "Inline");
  assert.ok(
    undo(state, (transaction) => {
      state = state.apply(transaction);
    }),
  );
  assert.ok(state.doc.eq(doc));
  state = state.apply(imageLayoutTransaction(state, { position: 7, attrs: { layout: "right" } }));
  state = state.apply(imageLayoutTransaction(state, { position: state.selection.from, attrs: { layout: "inline" } }));
  state.doc.check();
  assert.equal(selectedNode(state.selection).type.name, "image");
  assert.equal(selectedNode(state.selection).attrs.explicitInline, true);
  assert.equal(state.selection.$from.parent.type.name, "paragraph");
  assert.equal(state.doc.childCount, 1);
  assert.equal(state.doc.child(0).textContent, "BeforeAfter");
});
test("side-by-side images form one undoable inline row without losing surrounding text or image attributes", () => {
  const doc = document(paragraph("Before"), image("First"), image("Second", "right"), paragraph("After"));
  let state = selectedState(doc, 8);
  assert.deepEqual(imageRowNeighbor(doc, 8), { from: 8, to: 9, after: false });
  state = state.apply(required(imageRowTransaction(state, required(imageRowNeighbor(doc, 8)))));
  state.doc.check();
  assert.equal(state.doc.childCount, 3);
  assert.equal(imageRowCount(state.doc.child(1)), 2);
  assert.deepEqual(
    images(state.doc).map((node) => [node.attrs.alt, node.attrs.width, node.attrs.layout, node.attrs.explicitInline]),
    [
      ["First", "50%", "inline", true],
      ["Second", "50%", "inline", true],
    ],
  );
  assert.equal(selectedNode(state.selection).attrs.alt, "First");
  assert.equal(state.doc.textContent, "BeforeAfter");
  assert.ok(
    undo(state, (transaction) => {
      state = state.apply(transaction);
    }),
  );
  assert.ok(state.doc.eq(doc));
  assert.ok(
    redo(state, (transaction) => {
      state = state.apply(transaction);
    }),
  );
  assert.equal(imageRowCount(state.doc.child(1)), 2);
  assert.equal(imageRowCount(paragraph(image("Inline", "inline"), image("Other", "inline"), "After")), 2);
  assert.equal(imageRowCount(paragraph("Text", image("Inline", "inline"), image("Other", "inline"))), 0);
});
test("side-by-side moves and copies preserve order and remove vacated image-only list items", () => {
  const doc = document(
    schema.node("bullet_list", null, schema.node("list_item", null, image("Listed"))),
    image("Target"),
  );
  for (const copy of [false, true]) {
    const transaction = required(imageRowTransaction(selectedState(doc, 2), { from: 2, to: 5, after: true, copy }));
    transaction.doc.check();
    assert.deepEqual(
      images(transaction.doc).map((node) => node.attrs.alt),
      copy ? ["Listed", "Target", "Listed"] : ["Target", "Listed"],
    );
    assert.equal(imageRowCount(required(transaction.doc.lastChild)), 2);
    assert.equal(transaction.doc.childCount, copy ? 2 : 1);
  }
  const pair = document(image("First"), image("Second"));
  assert.deepEqual(imageRowNeighbor(pair, 1), { from: 1, to: 0, after: true });
  assert.equal(imageRowTransaction(selectedState(pair), { from: 0, to: 0 }), null);
});
test("dropping beside a standalone inline image creates one row and preserves surrounding paragraphs and undo", () => {
  const doc = document(paragraph(image("Target", "inline")), image("Dragged", "right"), paragraph("Tail"));
  let state = selectedState(doc, 3);
  state = state.apply(required(imageRowTransaction(state, { from: 3, to: 1 })));
  state.doc.check();
  assert.equal(state.doc.childCount, 2);
  assert.equal(imageRowCount(state.doc.child(0)), 2);
  assert.deepEqual(
    images(state.doc).map((node) => node.attrs.alt),
    ["Target", "Dragged"],
  );
  assert.equal(state.doc.textContent, "Tail");
  assert.equal(selectedNode(state.selection).attrs.alt, "Dragged");
  assert.ok(
    undo(state, (transaction) => {
      state = state.apply(transaction);
    }),
  );
  assert.ok(state.doc.eq(doc));
  const mixed = document(paragraph("Text", image("Inline", "inline")));
  assert.equal(imageRowTarget(mixed, 5), null);
});
test("moving and copying into existing rows preserve all images and keep their order and widths consistent", () => {
  const doc = document(paragraph(image("First", "inline"), image("Second", "inline")), image("Third"));
  for (const copy of [false, true]) {
    const transaction = required(imageRowTransaction(selectedState(doc, 4), { from: 4, to: 2, copy }));
    transaction.doc.check();
    assert.equal(imageRowCount(transaction.doc.child(0)), 3);
    assert.deepEqual(
      images(transaction.doc).map((node) => node.attrs.alt),
      copy ? ["First", "Second", "Third", "Third"] : ["First", "Second", "Third"],
    );
    assert.deepEqual(
      images(transaction.doc)
        .slice(0, 3)
        .map((node) => node.attrs.width),
      ["33%", "33%", "33%"],
    );
  }
  const row = document(paragraph(image("First", "inline"), image("Second", "inline"), image("Third", "inline")));
  const moved = required(imageRowTransaction(selectedState(row, 1), { from: 1, to: 3 }));
  moved.doc.check();
  assert.equal(moved.doc.childCount, 1);
  assert.equal(imageRowCount(moved.doc.child(0)), 3);
  assert.deepEqual(
    images(moved.doc).map((node) => node.attrs.alt),
    ["Second", "Third", "First"],
  );
  assert.equal(selectedNode(moved.selection).attrs.alt, "First");
});
test("layout changes allow image-leading lists without placeholders and reject unsupported table positions", () => {
  const doc = document(
    schema.node("bullet_list", null, schema.node("list_item", null, paragraph(image("List", "inline")))),
  );
  const moved = imageLayoutTransaction(selectedState(doc, 3), { position: 3, attrs: { layout: "left" } });
  moved.doc.check();
  assert.equal(moved.doc.child(0).child(0).childCount, 1);
  assert.equal(moved.doc.child(0).child(0).child(0).type.name, "image_block");
  assert.equal(required(moved.doc.child(0).child(0).lastChild).type.name, "image_block");
  const table = document(
    schema.node("table", null, schema.node("table_cell", null, paragraph(image("Cell", "inline")))),
  );
  assert.throws(
    () =>
      imageLayoutTransaction(selectedState(table, 3), {
        position: 3,
        attrs: { layout: "center" },
      }),
    /only supports inline images/,
  );
  const legacy = document(
    schema.node(
      "table",
      null,
      schema.node("table_cell", null, paragraph(schema.node("image", { src: "old.png", layout: "center" }))),
    ),
  );
  const replaced = imageLayoutTransaction(selectedState(legacy, 3), {
    position: 3,
    attrs: { src: "new.png", width: "240" },
  });
  replaced.doc.check();
  assert.equal(selectedNode(replaced.selection).type.name, "image");
  assert.equal(selectedNode(replaced.selection).attrs.src, "new.png");
});
test("Backspace and Delete select adjacent images before removing them, including between blocks", () => {
  const doc = document(image("First"), paragraph("After"));
  let state = EditorState.create({ doc, selection: TextSelection.create(doc, 2), plugins: [history()] });
  state = state.apply(required(imageKeyTransaction(state, "Backspace")));
  assert.ok(state.selection instanceof NodeSelection);
  assert.equal(state.doc, doc);
  state = state.apply(required(imageKeyTransaction(state, "Backspace")));
  assert.equal(images(state.doc).length, 0);
  assert.equal(state.doc.textContent, "After");
  assert.ok(
    undo(state, (transaction) => {
      state = state.apply(transaction);
    }),
  );
  assert.ok(state.doc.eq(doc));
  const pair = document(image("First"), image("Second"));
  for (const [key, expected] of [
    ["Backspace", "First"],
    ["Delete", "Second"],
  ]) {
    const current = EditorState.create({ doc: pair, selection: new GapCursor(pair.resolve(1)) });
    const transaction = required(imageKeyTransaction(current, key));
    assert.equal(selectedNode(transaction.selection).attrs.alt, expected);
    assert.equal(transaction.doc, pair);
  }
});
test("moving or copying block images keeps formatting, selects the inserted image and leaves no ghost paragraph", () => {
  const doc = document(image("First"), image("Second", "right"), paragraph("Tail"));
  for (const copy of [false, true]) {
    const state = selectedState(doc);
    const moved = state.apply(required(imageMoveTransaction(state, { from: 0, to: 2, copy })));
    moved.doc.check();
    assert.deepEqual(
      images(moved.doc).map((node) => node.attrs.alt),
      copy ? ["First", "Second", "First"] : ["Second", "First"],
    );
    assert.equal(selectedNode(moved.selection).attrs.alt, "First");
    assert.equal(moved.doc.childCount, copy ? 4 : 3);
    assert.equal(images(moved.doc)[copy ? 1 : 0].attrs.layout, "right");
  }
  assert.equal(imageMoveTransaction(selectedState(doc), { from: 0, to: 1 }), null);
});
test("moving a standalone inline image removes its old empty wrapper, but deleting the last image leaves an editable document", () => {
  const doc = document(paragraph(image("First", "inline")), paragraph("Target"));
  const moved = required(imageMoveTransaction(selectedState(doc, 1), { from: 1, to: 10 }));
  moved.doc.check();
  assert.equal(moved.doc.childCount, 1);
  assert.equal(moved.doc.textContent, "Target");
  const last = document(image("Only"));
  const removed = required(imageRemovalTransaction(selectedState(last), 0));
  removed.doc.check();
  assert.equal(removed.doc.child(0).type.name, "paragraph");
});
test("uploads insert blocks at empty paragraphs and gaps, but retain genuine inline flow within text", () => {
  const empty = document(paragraph());
  const inserted = imageInsertionTransaction(EditorState.create({ doc: empty }), { images: [image("New", "inline")] });
  inserted.doc.check();
  assert.equal(inserted.doc.child(0).type.name, "image_block");
  assert.ok(inserted.selection instanceof GapCursor);
  const text = document(paragraph("BeforeAfter"));
  const inline = imageInsertionTransaction(
    EditorState.create({ doc: text, selection: TextSelection.create(text, 7) }),
    {
      images: [image("New", "inline")],
    },
  );
  inline.doc.check();
  assert.equal(inline.doc.childCount, 1);
  assert.equal(images(inline.doc)[0].type.name, "image");
  assert.equal(inline.selection.head, 8);
  const pair = document(image("First"), image("Second"));
  const between = imageInsertionTransaction(
    EditorState.create({ doc: pair, selection: new GapCursor(pair.resolve(1)) }),
    {
      images: [image("New", "inline"), image("Other", "inline")],
    },
  );
  between.doc.check();
  assert.deepEqual(
    images(between.doc).map((node) => node.attrs.alt),
    ["First", "New", "Other", "Second"],
  );
  assert.equal(between.doc.childCount, 4);
  assert.ok(between.selection instanceof GapCursor);
  for (const position of [1, 12]) {
    const dropped = imageInsertionTransaction(
      EditorState.create({ doc: text, selection: TextSelection.create(text, position) }),
      {
        images: [image("Dropped", "inline")],
        block: true,
      },
    );
    dropped.doc.check();
    assert.equal(images(dropped.doc)[0].type.name, "image_block");
    assert.equal(dropped.doc.textContent, "BeforeAfter");
    assert.equal(dropped.doc.childCount, 2);
  }
});
test("node and gap selections remain authoritative when publishing source or collaboration positions", () => {
  const doc = document(image("First"), image("Second"));
  for (const selection of [NodeSelection.create(doc, 0), new GapCursor(doc.resolve(1))]) {
    const unexpectedDOM = (): never => {
      throw new Error("Non-text selections must not be reconstructed from the DOM.");
    };
    const view = {
      state: { selection },
      posAtDOM: unexpectedDOM,
      dom: {
        contains: unexpectedDOM,
        ownerDocument: {
          getSelection() {
            throw new Error("Non-text selections must not be reconstructed from the DOM.");
          },
        },
      },
    };
    assert.equal(currentViewSelection(view), selection);
  }
});
test("native text transactions at a gap create an editable paragraph and remain undoable", () => {
  const doc = document(image("First"), image("Second"));
  let state = EditorState.create({ doc, selection: new GapCursor(doc.resolve(1)), plugins: [history()] });
  state = state.apply(state.tr.insertText("中文图文编辑"));
  state.doc.check();
  assert.equal(state.doc.childCount, 3);
  assert.equal(state.doc.child(1).type.name, "paragraph");
  assert.equal(state.doc.child(1).textContent, "中文图文编辑");
  assert.ok(state.selection instanceof TextSelection);
  assert.equal(state.selection.head, 8);
  assert.deepEqual(
    images(state.doc).map((node) => node.attrs.alt),
    ["First", "Second"],
  );
  assert.ok(
    undo(state, (transaction) => {
      state = state.apply(transaction);
    }),
  );
  assert.ok(state.doc.eq(doc));
});
test("image-leading items retain native list split, indent and outdent behavior", () => {
  const item = (...nodes: Node[]) => schema.node("list_item", null, nodes);
  const list = (...items: Node[]) => schema.node("bullet_list", null, items);
  const doc = document(list(item(paragraph("Parent")), item(image("Listed"), paragraph("Caption"))));
  let position: number | undefined;
  doc.descendants((node, from) => {
    if (node.type.name === "image_block") position = from;
  });
  assert.ok(position !== undefined);
  let state = selectedState(doc, position);
  assert.ok(
    sinkListItem(schema.nodes.list_item)(state, (transaction) => {
      state = state.apply(transaction);
    }),
  );
  state.doc.check();
  assert.equal(images(state.doc).length, 1);
  assert.ok(
    liftListItem(schema.nodes.list_item)(state, (transaction) => {
      state = state.apply(transaction);
    }),
  );
  state.doc.check();
  let caption: number | undefined;
  state.doc.descendants((node, from) => {
    if (node.isText && node.text === "Caption") caption = from + node.text.length;
  });
  assert.ok(caption !== undefined);
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, caption)));
  assert.ok(
    splitListItem(schema.nodes.list_item)(state, (transaction) => {
      state = state.apply(transaction);
    }),
  );
  state.doc.check();
  assert.equal(images(state.doc).length, 1);
  assert.equal(state.doc.child(0).childCount, 3);
});
test("moving an item's only image removes the empty item without losing the remaining list", () => {
  const item = (...nodes: Node[]) => schema.node("list_item", null, nodes);
  const doc = document(
    schema.node("bullet_list", null, [item(image("Listed")), item(paragraph("Kept"))]),
    image("Target"),
  );
  const state = selectedState(doc, 2);
  const moved = required(imageMoveTransaction(state, { from: 2, to: doc.content.size }));
  moved.doc.check();
  assert.equal(moved.doc.child(0).childCount, 1);
  assert.equal(moved.doc.child(0).child(0).textContent, "Kept");
  assert.deepEqual(
    images(moved.doc).map((node) => node.attrs.alt),
    ["Target", "Listed"],
  );
});
