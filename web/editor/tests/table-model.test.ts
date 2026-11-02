import { required } from "./fixtures.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { Schema, type Node } from "@milkdown/prose/model";
import { EditorState, TextSelection } from "@milkdown/prose/state";
import { TableMap, tableNodes } from "@milkdown/prose/tables";
import { history, undo } from "@milkdown/prose/history";
import { tableActionTransaction, tableAxisTransaction } from "../src/table-model.ts";
const tables = tableNodes({
  tableGroup: "block",
  cellContent: "paragraph",
  cellAttributes: { alignment: { default: "left" } },
});
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "text*", group: "block" },
    text: {},
    ...tables,
    table: { ...tables.table, content: "table_header_row table_row+" },
    table_header_row: { ...tables.table_row, content: "table_header+" },
    table_row: { ...tables.table_row, content: "table_cell+" },
  },
  marks: { strong: {} },
});
const paragraph = (text: string) => schema.node("paragraph", null, text ? schema.text(text) : []);
const makeTable = () =>
  schema.node("table", null, [
    schema.node(
      "table_header_row",
      null,
      ["Name", "State"].map((value) => schema.node("table_header", null, paragraph(value))),
    ),
    schema.node("table_row", null, [
      schema.node("table_cell", null, schema.node("paragraph", null, schema.text("A", [schema.mark("strong")]))),
      schema.node("table_cell", null, paragraph("Draft")),
    ]),
    schema.node(
      "table_row",
      null,
      ["B", "Ready"].map((value) => schema.node("table_cell", null, paragraph(value))),
    ),
  ]);
const createState = () => {
  const table = makeTable();
  const doc = schema.node("doc", null, [paragraph("Before"), table, paragraph("After")]);
  return EditorState.create({
    doc,
    selection: TextSelection.near(doc.resolve(9 + TableMap.get(table).map[3] + 1)),
    plugins: [history()],
  });
};
const matrix = (table: Node) => {
  const result: string[][] = [];
  table.forEach((row) => {
    const cells: string[] = [];
    row.forEach((cell) => cells.push(cell.textContent));
    result.push(cells);
  });
  return result;
};
const apply = (state: EditorState, axis: string, index: number, action: string) =>
  state.apply(tableAxisTransaction(state, { position: 8, axis, index, action }));
test("row and column duplication retain values, formatting and one-step undo without changing neighboring blocks", () => {
  for (const axis of ["row", "column"]) {
    const initial = createState();
    let state = apply(initial, axis, axis === "row" ? 1 : 0, "duplicate");
    state.doc.check();
    assert.deepEqual(
      matrix(state.doc.child(1)),
      axis === "row"
        ? [
            ["Name", "State"],
            ["A", "Draft"],
            ["A", "Draft"],
            ["B", "Ready"],
          ]
        : [
            ["Name", "Name", "State"],
            ["A", "A", "Draft"],
            ["B", "B", "Ready"],
          ],
    );
    assert.equal(state.doc.child(0).textContent, "Before");
    assert.equal(required(state.doc.lastChild).textContent, "After");
    assert.equal(state.doc.child(1).child(1).child(0).child(0).child(0).marks[0].type.name, "strong");
    assert.ok(
      undo(state, (tr) => {
        state = state.apply(tr);
      }),
    );
    assert.ok(state.doc.eq(initial.doc));
  }
});
test("inserting above or deleting the header preserves Markdown header/data-row structure and content", () => {
  const initial = createState();
  const inserted = apply(initial, "row", 0, "before");
  inserted.doc.check();
  assert.deepEqual(matrix(inserted.doc.child(1)), [
    ["", ""],
    ["Name", "State"],
    ["A", "Draft"],
    ["B", "Ready"],
  ]);
  assert.equal(inserted.doc.child(1).child(1).type.name, "table_row");
  const deleted = apply(initial, "row", 0, "delete");
  deleted.doc.check();
  assert.deepEqual(matrix(deleted.doc.child(1)), [
    ["A", "Draft"],
    ["B", "Ready"],
  ]);
  assert.equal(deleted.doc.child(1).child(0).type.name, "table_header_row");
  assert.equal(deleted.doc.child(1).child(0).child(0).type.name, "table_header");
});
test("column insertion, clearing and alignment affect only the intended cells", () => {
  let state = apply(createState(), "column", 1, "before");
  state.doc.check();
  assert.deepEqual(matrix(state.doc.child(1)), [
    ["Name", "", "State"],
    ["A", "", "Draft"],
    ["B", "", "Ready"],
  ]);
  state = apply(state, "column", 2, "align-right");
  state.doc.child(1).forEach((row) => assert.equal(row.child(2).attrs.alignment, "right"));
  state = apply(state, "column", 0, "clear");
  state.doc.check();
  assert.deepEqual(matrix(state.doc.child(1)), [
    ["", "", "State"],
    ["", "", "Draft"],
    ["", "", "Ready"],
  ]);
  state = apply(state, "row", 1, "clear");
  assert.deepEqual(matrix(state.doc.child(1)), [
    ["", "", "State"],
    ["", "", ""],
    ["", "", "Ready"],
  ]);
});
test("deletion keeps the last required Markdown row and column and rejects stale targets explicitly", () => {
  let state = apply(createState(), "row", 2, "delete");
  assert.throws(() => apply(state, "row", 1, "delete"), /header and at least one data row/);
  state = apply(state, "column", 1, "delete");
  state.doc.check();
  assert.throws(() => apply(state, "column", 0, "delete"), /at least one column/);
  assert.throws(() => apply(state, "column", 5, "duplicate"), /no longer available/);
  assert.throws(
    () => tableAxisTransaction(state, { position: 0, axis: "row", index: 0, action: "clear" }),
    /no longer editable/,
  );
});
test("whole-table alignment and clearing retain structure, formatting and one-step undo", () => {
  const initial = createState();
  let state = initial.apply(tableActionTransaction(initial, { position: 8, action: "align-center" }));
  state.doc.check();
  state.doc.child(1).forEach((row) => row.forEach((cell) => assert.equal(cell.attrs.alignment, "center")));
  assert.equal(state.doc.child(1).child(1).child(0).child(0).child(0).marks[0].type.name, "strong");
  state = state.apply(tableActionTransaction(state, { position: 8, action: "clear" }));
  state.doc.check();
  assert.deepEqual(matrix(state.doc.child(1)), [
    ["", ""],
    ["", ""],
    ["", ""],
  ]);
  assert.ok(
    undo(state, (tr) => {
      state = state.apply(tr);
    }),
  );
  assert.deepEqual(matrix(state.doc.child(1)), [
    ["Name", "State"],
    ["A", "Draft"],
    ["B", "Ready"],
  ]);
  assert.ok(
    undo(state, (tr) => {
      state = state.apply(tr);
    }),
  );
  assert.ok(state.doc.eq(initial.doc));
});
test("whole-table duplication and deletion preserve neighboring blocks and keep an empty note editable", () => {
  const initial = createState();
  let state = initial.apply(tableActionTransaction(initial, { position: 8, action: "duplicate" }));
  state.doc.check();
  assert.equal(state.doc.childCount, 4);
  assert.ok(state.doc.child(1).eq(state.doc.child(2)));
  assert.equal(required(state.doc.lastChild).textContent, "After");
  state = state.apply(tableActionTransaction(state, { position: 8, action: "delete" }));
  state.doc.check();
  assert.equal(state.doc.childCount, 3);
  assert.equal(state.doc.child(0).textContent, "Before");
  assert.ok(
    undo(state, (tr) => {
      state = state.apply(tr);
    }),
  );
  assert.equal(state.doc.childCount, 4);
  const only = EditorState.create({ doc: schema.node("doc", null, makeTable()) });
  const removed = tableActionTransaction(only, { position: 0, action: "delete" });
  removed.doc.check();
  assert.equal(removed.doc.child(0).type.name, "paragraph");
});
