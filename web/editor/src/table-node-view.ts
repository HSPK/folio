import { CellSelection, selectedRect, TableMap } from "@milkdown/prose/tables";
import { Selection, TextSelection } from "@milkdown/prose/state";
import type { Node as ProseNode } from "@milkdown/prose/model";
import type { EditorView, NodeViewConstructor } from "@milkdown/prose/view";
import { createNodeToolbar, toolButton } from "./node-toolbar.ts";
import { canDeleteTableAxis, tableActionTransaction, tableAxisTransaction, type TableAxis } from "./table-model.ts";
import { tableFormat } from "./table-formats.ts";
import { focusEditorView } from "./cursor-coordinates.ts";
import { closestElement, nodeElement } from "./dom.ts";
import { errorMessage } from "./errors.ts";
import type { InlineEditorOptions, NodeActivity } from "./types/editor.ts";

type MenuAxis = TableAxis | "table";

export interface TableHandle extends NodeActivity {
  owns_fn: (view: EditorView) => boolean;
  view_fn: () => EditorView;
  selected_fn: () => boolean;
  axis_fn: () => MenuAxis;
  anchor_fn: () => HTMLElement;
  trigger_fn: () => HTMLElement;
  open_fn: (axis: MenuAxis, anchor: HTMLElement, onClose_fn?: () => void) => void;
  closed_fn: () => void;
  focus_fn: () => void;
  can_fn: (action: string) => boolean;
  menuSelection_fn: () => boolean;
  alignment_fn: () => string | null;
  run_fn: (action: string) => void;
  format_fn: (format: string) => string;
  reactivate_fn: () => void;
  dismiss_fn: () => void;
  deactivate_fn: () => void;
  refresh_fn: () => void;
}

export interface TableViewOptions extends NodeActivity {
  serialize_fn: (node: ProseNode) => string;
}

interface TableControls {
  toolbarId: string;
  menu: ReturnType<typeof createNodeToolbar<TableHandle>>;
  onNotice?: InlineEditorOptions["onNotice"];
  focusMenu_fn: (axis: MenuAxis) => void;
  activate_fn: (handle: TableHandle) => void;
  register_fn: (dom: HTMLElement, handle: TableHandle) => () => void;
}

export function createTableNodeView(
  { active_fn, editable_fn, serialize_fn }: TableViewOptions,
  { toolbarId, menu, onNotice, focusMenu_fn, activate_fn, register_fn }: TableControls,
): NodeViewConstructor {
  return (initial, view, getPos) => {
    let node = initial;
    let axis: MenuAxis = "column";
    let index = 0;
    let restoreSelection: Selection | null = null;
    let restoreDocument: ProseNode | null = null;
    let suppressed: Selection | null = null;
    let trigger: HTMLElement | null = null;
    let closeBlock_fn: (() => void) | undefined;
    const position = () => {
      const value = getPos();
      if (typeof value !== "number") throw new Error("This table is no longer in the document.");
      return value;
    };
    const dom = document.createElement("div");
    dom.className = "folio-table-wrapper";
    const scroll = document.createElement("div");
    scroll.className = "folio-table-scroll";
    const table = document.createElement("table");
    const contentDOM = document.createElement("tbody");
    table.append(contentDOM);
    scroll.append(table);
    const outline = document.createElement("div");
    outline.className = "folio-table-selection";
    outline.setAttribute("aria-hidden", "true");
    outline.hidden = true;
    dom.append(scroll, outline);
    const inside = () => {
      const at = getPos();
      return (
        active_fn() &&
        typeof at === "number" &&
        view.state.selection.from > at &&
        view.state.selection.to < at + node.nodeSize
      );
    };
    const select = () => {
      suppressed = null;
      if (!inside())
        view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(position() + 3))));
    };
    function grip(value: TableAxis) {
      const button = toolButton({
        label: `${value === "row" ? "Row" : "Column"} actions`,
        icon: "grip",
        onClick: () => handle.open_fn(value, button),
      });
      button.className = `folio-table-grip folio-table-${value}-grip`;
      button.contentEditable = "false";
      button.tabIndex = -1;
      button.setAttribute("aria-haspopup", "menu");
      button.setAttribute("aria-expanded", "false");
      button.setAttribute("aria-controls", toolbarId);
      dom.append(button);
      return button;
    }
    const grips = { row: grip("row"), column: grip("column") };
    const appendControls: HTMLButtonElement[] = [];
    for (const value of ["row", "column"] as const) {
      const button = toolButton({
        label: `Add ${value} at end`,
        icon: "plus",
        onClick: () => {
          try {
            if (!active_fn() || !editable_fn()) throw new Error("This table is no longer editable.");
            const last = value === "row" ? node.childCount - 1 : TableMap.get(node).width - 1;
            view.dispatch(
              tableAxisTransaction(view.state, { position: position(), axis: value, index: last, action: "after" }),
            );
            menu.close();
            view.focus();
            onNotice?.("");
          } catch (error) {
            onNotice?.(`Could not edit table: ${errorMessage(error)}`, "error");
          }
        },
      });
      button.className = `folio-table-add folio-table-add-${value}`;
      button.contentEditable = "false";
      button.tabIndex = -1;
      appendControls.push(button);
      const region = document.createElement("div");
      region.className = `folio-table-add-region folio-table-add-region-${value}`;
      region.contentEditable = "false";
      region.append(button);
      dom.append(region);
    }
    const controls = [...Object.values(grips), ...appendControls];
    const cellDOM = (map: TableMap, row: number, column: number) =>
      nodeElement(view.nodeDOM(position() + 1 + map.map[row * map.width + column]));
    const place = (element: HTMLElement, bounds: Pick<DOMRect, "left" | "top" | "width" | "height">) => {
      for (const name of ["left", "top", "width", "height"] as const) {
        const value = `${bounds[name]}px`;
        if (element.style[name] !== value) element.style[name] = value;
      }
    };
    const handle: TableHandle = {
      active_fn: () => active_fn() && typeof getPos() === "number",
      owns_fn: (candidate) => candidate === view,
      view_fn: () => view,
      editable_fn,
      selected_fn: () => (axis === "table" ? handle.menuSelection_fn() : inside()),
      axis_fn: () => axis,
      anchor_fn: () => trigger ?? dom,
      trigger_fn: () => trigger ?? dom,
      open_fn(value, anchor, onClose_fn) {
        if (value !== "table") select();
        menu.close();
        restoreSelection = view.state.selection;
        restoreDocument = view.state.doc;
        axis = value;
        trigger = anchor;
        closeBlock_fn = onClose_fn;
        if (axis !== "table") {
          const rect = selectedRect(view.state);
          index = axis === "row" ? rect.top : rect.left;
          const map = TableMap.get(node);
          const start = position() + 1;
          const first = start + map.map[axis === "row" ? index * map.width : index];
          const last =
            start + map.map[axis === "row" ? (index + 1) * map.width - 1 : (map.height - 1) * map.width + index];
          view.dispatch(view.state.tr.setSelection(CellSelection.create(view.state.doc, first, last)));
        }
        menu.open(dom);
        focusMenu_fn(axis);
      },
      closed_fn() {
        const closed = closeBlock_fn;
        closeBlock_fn = undefined;
        closed?.();
      },
      focus_fn() {
        const next =
          axis !== "table" && inside() && view.state.selection instanceof CellSelection
            ? restoreDocument === view.state.doc
              ? restoreSelection
              : TextSelection.near(view.state.doc.resolve(view.state.selection.from + 1))
            : null;
        focusEditorView(view, next);
      },
      can_fn: (action) => axis === "table" || action !== "delete" || canDeleteTableAxis(node, axis),
      menuSelection_fn: () =>
        axis === "table"
          ? view.state.doc === restoreDocument && restoreSelection !== null && view.state.selection.eq(restoreSelection)
          : inside() && view.state.selection instanceof CellSelection,
      alignment_fn() {
        const header = node.firstChild;
        if (!header) throw new Error("This table has no header row.");
        if (axis !== "table") return header.child(Math.min(index, header.childCount - 1)).attrs.alignment ?? "left";
        const values: string[] = [];
        header.forEach((cell) => values.push(cell.attrs.alignment ?? "left"));
        return values.every((value) => value === values[0]) ? values[0] : null;
      },
      run_fn(action) {
        if (!editable_fn()) throw new Error("This table is no longer editable.");
        view.dispatch(
          axis === "table"
            ? tableActionTransaction(view.state, { position: position(), action })
            : tableAxisTransaction(view.state, { position: position(), axis, index, action }),
        );
      },
      format_fn: (format) => tableFormat({ table: node, format, markdown_fn: serialize_fn }),
      reactivate_fn() {
        suppressed = null;
      },
      dismiss_fn() {
        const selection = view.dom.ownerDocument.getSelection();
        const at =
          selection?.focusNode && dom.contains(selection.focusNode)
            ? view.posAtDOM(selection.focusNode, selection.focusOffset)
            : view.state.selection instanceof CellSelection
              ? view.state.selection.$headCell.pos + 1
              : view.state.selection.head;
        suppressed = TextSelection.near(view.state.doc.resolve(at));
        if (!view.state.selection.eq(suppressed))
          view.dispatch(view.state.tr.setSelection(suppressed).setMeta("addToHistory", false));
        handle.deactivate_fn();
        view.dom.blur();
        view.dom.ownerDocument.getSelection()?.removeAllRanges();
      },
      deactivate_fn() {
        dom.classList.remove("is-active");
        outline.hidden = true;
        for (const control of controls) control.tabIndex = -1;
      },
      refresh_fn() {
        if (!inside() || (suppressed && (!view.hasFocus() || view.state.selection.eq(suppressed)))) {
          handle.deactivate_fn();
          return;
        }
        suppressed = null;
        dom.classList.add("is-active");
        const map = TableMap.get(node);
        const rect = selectedRect(view.state);
        const start = cellDOM(map, rect.top, rect.left)?.getBoundingClientRect();
        const end = cellDOM(map, rect.bottom - 1, rect.right - 1)?.getBoundingClientRect();
        const column = cellDOM(map, 0, rect.left)?.getBoundingClientRect();
        const row = cellDOM(map, rect.top, 0)?.getBoundingClientRect();
        if (!start || !end || !column || !row) return;
        const bounds = dom.getBoundingClientRect();
        const viewport = scroll.getBoundingClientRect();
        const left = Math.max(start.left, viewport.left);
        const right = Math.min(end.right, viewport.right);
        outline.hidden = right <= left;
        place(outline, {
          left: left - bounds.left,
          top: start.top - bounds.top,
          width: Math.max(0, right - left),
          height: end.bottom - start.top,
        });
        place(grips.column, {
          left: Math.max(0, Math.min(viewport.width - 28, column.left + column.width / 2 - bounds.left - 14)),
          top: viewport.top - bounds.top - 7,
          width: 28,
          height: 14,
        });
        place(grips.row, {
          left: viewport.left - bounds.left - 7,
          top: row.top + row.height / 2 - bounds.top - 14,
          width: 14,
          height: 28,
        });
        for (const control of Object.values(grips)) control.tabIndex = 0;
        for (const control of appendControls) control.hidden = !editable_fn();
      },
    };
    const unregister = register_fn(dom, handle);
    const updateWidth = () => {
      const width = `${TableMap.get(node).width * 112}px`;
      if (table.style.minWidth !== width) table.style.minWidth = width;
    };
    updateWidth();
    dom.addEventListener("pointerdown", (event) => {
      if (!closestElement(event.target, "td, th")) return;
      suppressed = null;
      activate_fn(handle);
    });
    dom.addEventListener("click", (event) => {
      const cell = closestElement(event.target, "td, th");
      if (view.editable || !cell || !document.getSelection()?.isCollapsed) return;
      view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(view.posAtDOM(cell, 0)))));
    });
    return {
      dom,
      contentDOM,
      destroy: unregister,
      update(next) {
        if (next.type !== node.type) return false;
        node = next;
        updateWidth();
        return true;
      },
      ignoreMutation: (mutation) => mutation.type !== "selection" && !contentDOM.contains(mutation.target),
      stopEvent: (event) => {
        const target = event.target;
        return target instanceof Node && controls.some((control) => control.contains(target));
      },
    };
  };
}
