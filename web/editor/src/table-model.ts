import { TextSelection } from "@milkdown/prose/state";
import { TableMap, selectedRect } from "@milkdown/prose/tables";
import { closeHistory } from "@milkdown/prose/history";
import type { Node } from "@milkdown/prose/model";
import type { EditorState } from "@milkdown/prose/state";

export type TableAxis = "row" | "column";

export function canDeleteTableAxis(table: Node, axis: TableAxis) {
  return axis === "row" ? table.childCount > 2 : TableMap.get(table).width > 1;
}

function emptyCell(cell: Node) {
  const empty = cell.type.createAndFill(cell.attrs);
  if (!empty) throw new Error("The table could not create an empty Markdown cell.");
  return empty;
}

export function tableAxisTransaction(
  state: EditorState,
  {
    position,
    axis,
    index,
    action,
  }: {
    position: number;
    axis: string;
    index: number;
    action: string;
  },
) {
  const table = state.doc.nodeAt(position);
  if (table?.type.name !== "table" || !["row", "column"].includes(axis)) {
    throw new Error("This table is no longer editable.");
  }
  const map = TableMap.get(table);
  const size = axis === "row" ? map.height : map.width;
  if (!Number.isInteger(index) || index < 0 || index >= size)
    throw new Error("This row or column is no longer available.");
  const rows: { node: Node; cells: Node[] }[] = [];
  table.forEach((node) => {
    const cells: Node[] = [];
    node.forEach((cell) => cells.push(cell));
    if (cells.length !== map.width || cells.some((cell) => cell.attrs.colspan > 1 || cell.attrs.rowspan > 1)) {
      throw new Error("These actions require a simple Markdown table without merged cells.");
    }
    rows.push({ node, cells });
  });
  let row = axis === "row" ? index : 0;
  let column = axis === "column" ? index : 0;
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth) !== table) continue;
    const selected = selectedRect(state);
    if (axis === "row") column = selected.left;
    else row = selected.top;
    break;
  }
  const empty = emptyCell;
  if (["before", "after", "duplicate"].includes(action)) {
    const at = index + (action === "before" ? 0 : 1);
    if (axis === "row") {
      const source = rows[index];
      rows.splice(at, 0, {
        node: source.node,
        cells: source.cells.map((cell) => (action === "duplicate" ? cell : empty(cell))),
      });
      row = at;
    } else {
      for (const entry of rows)
        entry.cells.splice(at, 0, action === "duplicate" ? entry.cells[index] : empty(entry.cells[index]));
      column = at;
    }
  } else if (action === "clear") {
    if (axis === "row") rows[index].cells = rows[index].cells.map(empty);
    else for (const entry of rows) entry.cells[index] = empty(entry.cells[index]);
  } else if (action === "delete") {
    if (!canDeleteTableAxis(table, axis === "row" ? "row" : "column")) {
      throw new Error(axis === "row" ? "Keep a header and at least one data row." : "Keep at least one column.");
    }
    if (axis === "row") rows.splice(index, 1);
    else for (const entry of rows) entry.cells.splice(index, 1);
  } else if (/^align-(left|center|right)$/.test(action) && axis === "column") {
    const cell = rows[0].cells[index];
    rows[0].cells[index] = cell.type.create({ ...cell.attrs, alignment: action.slice(6) }, cell.content, cell.marks);
  } else throw new Error("This table action is unavailable.");
  const alignment = rows[0].cells.map((cell) => cell.attrs.alignment);
  // Markdown requires one header row followed by at least one data row.
  const content = rows.map((entry, rowIndex) => {
    const type = rowIndex === 0 ? state.schema.nodes.table_header : state.schema.nodes.table_cell;
    const cells = entry.cells.map((cell, columnIndex) =>
      type.create({ ...cell.attrs, alignment: alignment[columnIndex] }, cell.content, cell.marks),
    );
    const rowType = rowIndex === 0 ? state.schema.nodes.table_header_row : state.schema.nodes.table_row;
    return rowType.create(entry.node.attrs, cells, entry.node.marks);
  });
  const next = table.type.create(table.attrs, content, table.marks);
  const transaction = closeHistory(state.tr).replaceWith(position, position + table.nodeSize, next);
  const nextMap = TableMap.get(next);
  const cell =
    position + 1 + nextMap.map[Math.min(row, nextMap.height - 1) * nextMap.width + Math.min(column, nextMap.width - 1)];
  return transaction.setSelection(TextSelection.near(transaction.doc.resolve(cell + 1))).scrollIntoView();
}

export function tableActionTransaction(state: EditorState, { position, action }: { position: number; action: string }) {
  const table = state.doc.nodeAt(position);
  if (table?.type.name !== "table") throw new Error("This table is no longer editable.");
  const transaction = closeHistory(state.tr);
  if (action === "delete") {
    transaction.deleteRange(position, position + table.nodeSize);
    return transaction
      .setSelection(TextSelection.near(transaction.doc.resolve(Math.min(position, transaction.doc.content.size))))
      .scrollIntoView();
  }
  if (action === "duplicate") {
    const at = position + table.nodeSize;
    transaction.insert(at, table);
    return transaction.setSelection(TextSelection.near(transaction.doc.resolve(at + 3))).scrollIntoView();
  }
  if (action !== "clear" && !/^align-(left|center|right)$/.test(action))
    throw new Error("This table action is unavailable.");
  const rows: Node[] = [];
  table.forEach((row) => {
    const cells: Node[] = [];
    row.forEach((cell) =>
      cells.push(
        action === "clear"
          ? emptyCell(cell)
          : cell.type.create({ ...cell.attrs, alignment: action.slice(6) }, cell.content, cell.marks),
      ),
    );
    rows.push(row.type.create(row.attrs, cells, row.marks));
  });
  transaction.replaceWith(position, position + table.nodeSize, table.type.create(table.attrs, rows, table.marks));
  return transaction.setSelection(TextSelection.near(transaction.doc.resolve(position + 3))).scrollIntoView();
}
