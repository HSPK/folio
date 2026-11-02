import { CellSelection } from "@milkdown/prose/tables";
import { Plugin } from "@milkdown/prose/state";
import { $prose } from "@milkdown/utils";
import { createNodeToolbar, toolButton } from "./node-toolbar.ts";
import { createIcon } from "./icons.ts";
import { EditorView } from "@milkdown/prose/view";
import { createTableNodeView, type TableHandle, type TableViewOptions } from "./table-node-view.ts";
import type { InlineEditorOptions } from "./types/editor.ts";
import { nodeElement } from "./dom.ts";
import { errorMessage } from "./errors.ts";
import type { Lifetime } from "../../shared/lifetime.ts";
export function createTableTools({
  lifetime,
  root,
  onNotice,
}: {
  lifetime: Lifetime;
  root: HTMLElement;
  onNotice?: InlineEditorOptions["onNotice"];
}) {
  const toolbar = document.createElement("div");
  toolbar.id = "folio-table-tools";
  toolbar.className = "folio-table-tools";
  toolbar.setAttribute("aria-label", "Table actions");
  const heading = document.createElement("div");
  heading.className = "folio-table-menu-heading";
  heading.textContent = "Table settings";
  heading.setAttribute("role", "presentation");
  const actions = document.createElement("div");
  actions.className = "folio-table-actions";
  const items: {
    button: HTMLButtonElement;
    action: string;
    index: number;
  }[] = [];
  let activeTable: TableHandle | null = null;
  let shown: TableHandle | null = null;
  let frame = 0;
  const handles = new WeakMap<Node, TableHandle>();
  const labels = {
    row: ["Insert above", "Insert below", "Duplicate row", "Clear contents", "Delete row"],
    column: ["Insert left", "Insert right", "Duplicate column", "Clear contents", "Delete column"],
    table: ["", "", "Duplicate table", "Clear contents", "Delete table"],
  };
  function run(action: string) {
    try {
      const target = menu.target();
      if (!target?.editable_fn()) throw new Error("Select an editable table first.");
      target.run_fn(action);
      menu.close();
      target.focus_fn();
      onNotice?.("");
    } catch (error) {
      onNotice?.(`Could not edit table: ${errorMessage(error)}`, "error");
    }
  }
  for (const [index, action] of ["before", "after", "duplicate", "clear", "delete"].entries()) {
    const button = toolButton({
      label: labels.column[index],
      text: labels.column[index],
      icon: ["arrow-left", "arrow-right", "copy", "circle-x", "trash"][index],
      onClick: () => run(action),
    });
    button.setAttribute("role", "menuitem");
    button.dataset.tableAction = action;
    items.push({ button, action, index });
    actions.append(button);
  }
  const alignment = document.createElement("div");
  alignment.className = "folio-table-actions folio-table-alignment";
  alignment.setAttribute("role", "group");
  alignment.setAttribute("aria-label", "Alignment");
  const alignments = new Map<string, HTMLButtonElement>();
  for (const value of ["left", "center", "right"]) {
    const button = toolButton({
      label: `Align ${value}`,
      text: `Align ${value}`,
      icon: `align-${value}`,
      onClick: () => run(`align-${value}`),
    });
    button.setAttribute("role", "menuitemradio");
    const check = createIcon("check");
    check.classList.add("folio-menu-check");
    button.append(check);
    alignments.set(value, button);
    alignment.append(button);
  }
  const exports = document.createElement("details");
  exports.className = "folio-table-export";
  const toggle = document.createElement("summary");
  toggle.textContent = "Copy table as";
  const formats = document.createElement("div");
  formats.className = "folio-table-choices";
  for (const [format, text] of [
    ["markdown", "Markdown"],
    ["html", "HTML"],
    ["csv", "CSV"],
    ["tsv", "TSV"],
    ["json", "JSON"],
  ]) {
    const button = toolButton({
      label: `Copy table as ${text}`,
      text,
      onClick: async () => {
        try {
          const target = menu.target();
          if (!target) throw new Error("This table is no longer open.");
          await navigator.clipboard.writeText(target.format_fn(format));
          onNotice?.("");
        } catch (error) {
          onNotice?.(`Could not copy table: ${errorMessage(error)}`, "error");
        }
      },
    });
    formats.append(button);
  }
  exports.append(toggle, formats);
  toolbar.append(heading, actions, alignment, exports);
  lifetime.listen(exports, "toggle", () => menu.position());
  const menu = createNodeToolbar<TableHandle>({
    lifetime,
    root,
    toolbar,
    role: "menu",
    placement: "below-start",
    openOnHover: false,
    onShow(target) {
      if (shown !== target) exports.open = false;
      shown = target;
      const axis = target.axis_fn();
      heading.hidden = axis !== "table";
      exports.hidden = axis !== "table";
      target.trigger_fn().setAttribute("aria-expanded", "true");
      for (const { button, action, index } of items) {
        const text = labels[axis][index];
        if (button.lastChild) button.lastChild.textContent = text;
        button.setAttribute("aria-label", text);
        button.title = text;
        button.hidden = axis === "table" && index < 2;
        const icon = button.querySelector<SVGElement>("[data-icon]");
        if (index < 2 && icon) icon.style.transform = axis === "row" ? "rotate(90deg)" : "";
        button.disabled = !target.editable_fn() || !target.can_fn(action);
      }
      for (const [value, button] of alignments) {
        button.disabled = !target.editable_fn();
        button.setAttribute("aria-checked", String(value === target.alignment_fn()));
      }
      alignment.hidden = axis === "row";
    },
    onHide() {
      shown?.trigger_fn().setAttribute("aria-expanded", "false");
      shown?.closed_fn();
      shown = null;
    },
  });
  lifetime.listen(toolbar, "keydown", (event) => {
    const options = [...toolbar.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")].filter(
      (button) => (button.closest("details")?.open ?? true) && button.getClientRects().length,
    );
    if (["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      const index = options.findIndex((button) => button === document.activeElement);
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const next =
        index < 0 ? (direction > 0 ? 0 : options.length - 1) : (index + direction + options.length) % options.length;
      options[next]?.focus();
    }
  });
  const schedule = () => {
    if (!activeTable || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      activeTable?.refresh_fn();
      menu.position();
    });
  };
  lifetime.listen(root, "scroll", schedule, true);
  lifetime.listen(window, "resize", schedule);
  const resize = new ResizeObserver(schedule);
  lifetime.defer(() => {
    cancelAnimationFrame(frame);
    resize.disconnect();
    activeTable = shown = null;
  });
  resize.observe(root);
  const escape = (view: EditorView, event: KeyboardEvent) => {
    if (
      event.key !== "Escape" ||
      event.defaultPrevented ||
      event.isComposing ||
      view.composing ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.shiftKey ||
      document.querySelector("dialog[open]")
    )
      return false;
    const focus = view.dom.ownerDocument.getSelection()?.focusNode;
    const element = nodeElement(focus ?? null);
    const wrapper = element?.closest(".folio-table-wrapper");
    const target =
      wrapper && view.dom.contains(wrapper)
        ? handles.get(wrapper)
        : view.state.selection instanceof CellSelection || !view.editable
          ? activeTable
          : null;
    if (!target?.active_fn() || !target.owns_fn(view)) return false;
    event.preventDefault();
    menu.close();
    activeTable?.deactivate_fn();
    target.dismiss_fn();
    activeTable = null;
    return true;
  };
  lifetime.listen(document, "keydown", (event) => {
    const view = activeTable?.view_fn();
    if (view && !view.editable) escape(view, event);
  });
  return {
    plugin() {
      return $prose(() => new Plugin({ props: { handleKeyDown: escape } }));
    },
    close() {
      menu.close();
    },
    dismiss: menu.dismiss,
    position: menu.position,
    refresh() {
      activeTable?.refresh_fn();
      menu.refresh();
    },
    openBlock(view: EditorView, position: number, trigger: HTMLElement, onClose_fn?: () => void) {
      const dom = view.nodeDOM(position);
      const target = dom && handles.get(dom);
      if (!target?.active_fn() || !target.owns_fn(view)) throw new Error("This table is no longer open.");
      target.open_fn("table", trigger, onClose_fn);
    },
    updateSelection(view: EditorView) {
      const { $from } = view.state.selection;
      let selected: TableHandle | null = null;
      for (let depth = $from.depth; depth > 0; depth--) {
        if ($from.node(depth).type.name !== "table") continue;
        const dom = view.nodeDOM($from.before(depth));
        selected = dom ? (handles.get(dom) ?? null) : null;
        break;
      }
      if (activeTable !== selected) {
        activeTable?.deactivate_fn();
        activeTable = selected;
        if (view.hasFocus()) activeTable?.reactivate_fn();
        activeTable?.refresh_fn();
      } else schedule();
      const target = menu.target();
      if (target?.axis_fn() === "table") {
        if (!target.owns_fn(view) || !target.menuSelection_fn()) menu.close();
      } else if (target !== selected || (shown && !selected?.menuSelection_fn())) menu.close();
      menu.refresh();
    },
    nodeView(options: TableViewOptions) {
      return createTableNodeView(options, {
        toolbarId: toolbar.id,
        menu,
        onNotice,
        focusMenu_fn(axis) {
          (
            actions.querySelector<HTMLButtonElement>("button:not(:disabled):not([hidden])") ??
            (axis === "table" ? toggle : toolbar)
          ).focus({ preventScroll: true });
        },
        activate_fn(handle) {
          if (activeTable !== handle) {
            activeTable?.deactivate_fn();
            activeTable = handle;
          }
          schedule();
        },
        register_fn(dom, handle) {
          handles.set(dom, handle);
          const unregister = menu.register(dom, handle);
          return () => {
            unregister();
            handles.delete(dom);
            if (activeTable === handle) activeTable = null;
          };
        },
      });
    },
  };
}
