import { Plugin, type Selection } from "@milkdown/prose/state";
import type { Node as ProseNode } from "@milkdown/prose/model";
import type { EditorView } from "@milkdown/prose/view";
import { CellSelection } from "@milkdown/prose/tables";
import { $prose } from "@milkdown/utils";
import { createNodeToolbar, setToolVisibility } from "./node-toolbar.ts";
import { blockActionTransaction } from "./line-keymap.ts";
import { focusEditorView, syncViewSelection } from "./cursor-coordinates.ts";
import { closestElement, nodeElement, createButton } from "./dom.ts";
import { errorMessage } from "./errors.ts";
import type { InlineEditorOptions, NodeActivity } from "./types/editor.ts";
import type { createTableTools } from "./tables.ts";
import type { Lifetime } from "../../shared/lifetime.ts";
const names: Record<string, string> = {
  paragraph: "Text",
  heading: "Heading",
  blockquote: "Quote",
  code_block: "Code block",
  image_block: "Image block",
  table: "Table",
  list_item: "List item",
  bullet_list: "List",
  ordered_list: "List",
  hr: "Divider",
  math_block: "Math block",
};
interface BlockHandle extends NodeActivity {
  anchor_fn: () => HTMLElement;
  selected_fn: () => boolean;
  focus_fn: () => void;
}
interface CurrentBlock {
  dom: HTMLElement;
  node: ProseNode;
  position: number;
  view: EditorView;
  handle: BlockHandle;
}
function blockAtDOM(view: EditorView, target: Node | null) {
  const element = nodeElement(target);
  if (!element || !view.dom.contains(element) || element === view.dom) return null;
  let dom = closestElement(element, ".folio-table-wrapper, .folio-block-image, .folio-code-block, blockquote, li");
  if (!dom || !view.dom.contains(dom)) {
    if (!(element instanceof HTMLElement)) return null;
    dom = element;
    while (dom.parentElement && dom.parentElement !== view.dom) dom = dom.parentElement;
  }
  const resolved = view.state.doc.resolve(view.posAtDOM(dom, 0));
  const positions = [resolved.pos];
  for (let depth = resolved.depth; depth > 0; depth--) positions.push(resolved.before(depth));
  for (const position of positions) {
    const node = view.state.doc.nodeAt(position);
    if (node?.isBlock && view.nodeDOM(position) === dom) return { dom, node, position };
  }
  return null;
}
/** Vertical centre of a block's first line of text; blocks without text use their own box. */
function firstLine(dom: HTMLElement, bounds: DOMRect) {
  const fallback = bounds.height <= 44 ? bounds.top + bounds.height / 2 : bounds.top + 14;
  const walker = document.createTreeWalker(dom, NodeFilter.SHOW_TEXT);
  for (let text = walker.nextNode(), seen = 0; text && seen < 8; text = walker.nextNode(), seen++) {
    if (!text.nodeValue?.trim()) continue;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 1);
    const rect = range.getClientRects()[0];
    if (!rect?.height) continue;
    const centre = rect.top + rect.height / 2;
    return centre < bounds.top || centre > bounds.top + 64 ? fallback : centre;
  }
  return fallback;
}
export function createBlockTools({
  lifetime,
  root,
  tableTools,
  onNotice,
}: {
  lifetime: Lifetime;
  root: HTMLElement;
  tableTools: ReturnType<typeof createTableTools>;
  onNotice?: InlineEditorOptions["onNotice"];
}) {
  const toolbar = document.createElement("div");
  toolbar.id = "folio-block-tools";
  toolbar.className = "folio-block-tools";
  toolbar.setAttribute("aria-label", "Block actions");
  const actions = document.createElement("div");
  actions.className = "folio-block-actions";
  const views = new WeakMap<
    HTMLElement,
    NodeActivity & {
      view: EditorView;
    }
  >();
  let current: CurrentBlock | null = null;
  let unregister: (() => void) | null = null;
  let frame = 0;
  let restoreSelection: Selection | null = null;
  let restoreDocument: ProseNode | null = null;
  const controls = document.createElement("div");
  lifetime.defer(() => controls.remove());
  controls.className = "folio-block-controls";
  controls.setAttribute("role", "group");
  controls.setAttribute("aria-label", "Block controls");
  setToolVisibility(controls, false);
  const add = createButton({
    label: "Add below",
    icon: "plus",
    onClick() {
      try {
        if (!current?.handle.active_fn() || !current.handle.editable_fn()) throw new Error("Read-only");
        const { view, position } = current;
        const transaction = blockActionTransaction(view.state, { position, action: "insert" });
        close();
        view.dispatch(transaction);
        view.focus();
        onNotice?.("");
      } catch (error) {
        onNotice?.(`Add failed: ${errorMessage(error)}`, "error");
      }
    },
  });
  add.className = "folio-block-add";
  const grip = createButton({ label: "Block actions", icon: "grip", onClick: open });
  grip.className = "folio-block-grip";
  grip.setAttribute("aria-haspopup", "menu");
  grip.setAttribute("aria-expanded", "false");
  controls.append(add, grip);
  lifetime.listen(controls, "pointerdown", (event) => event.preventDefault());
  for (const [action, label, icon] of [
    ["duplicate", "Duplicate", "copy"],
    ["delete", "Delete", "trash"],
  ]) {
    const button = createButton({
      label,
      text: label,
      icon,
      onClick() {
        try {
          const target = menu.target();
          if (!target?.editable_fn() || !current) throw new Error("Read-only");
          const { view, position } = current;
          const transaction = blockActionTransaction(view.state, { position, action });
          close();
          view.dispatch(transaction);
          view.focus();
          onNotice?.("");
        } catch (error) {
          onNotice?.(`Edit failed: ${errorMessage(error)}`, "error");
        }
      },
    });
    button.setAttribute("role", "menuitem");
    button.dataset.blockAction = action;
    actions.append(button);
  }
  toolbar.append(actions);
  const menu = createNodeToolbar<BlockHandle>({
    lifetime,
    root,
    toolbar,
    role: "menu",
    placement: "below-start",
    openOnHover: false,
    onShow(target) {
      grip.setAttribute("aria-expanded", "true");
      for (const button of actions.querySelectorAll("button")) button.disabled = !target.editable_fn();
    },
    onHide() {
      grip.setAttribute("aria-expanded", "false");
    },
  });
  const expanded = () => grip.getAttribute("aria-expanded") === "true";
  function close() {
    menu.close();
    if (current?.node.type.name === "table" && expanded()) tableTools.close();
    unregister?.();
    unregister = null;
    current = null;
    setToolVisibility(controls, false);
    cancelAnimationFrame(frame);
    frame = 0;
  }
  function position() {
    frame = 0;
    if (!current) return;
    if (!current.handle.active_fn()) {
      close();
      return;
    }
    const bounds = current.dom.getBoundingClientRect();
    const viewport = (root.querySelector("[data-editor-scroller]") ?? root).getBoundingClientRect();
    if (viewport.height <= 0 || bounds.bottom <= viewport.top || bounds.top >= viewport.bottom) {
      close();
      return;
    }
    const edge =
      current.node.type.name === "image_block"
        ? current.view.dom
        : current.node.type.name === "list_item"
          ? (current.dom.parentElement ?? current.dom)
          : current.dom;
    const left = edge.getBoundingClientRect().left;
    const gripWidth = Math.min(20, Math.max(14, left - viewport.left - 30));
    const width = gripWidth * 2 + 1;
    const x = Math.max(viewport.left + 1, left - width - 6);
    // Centre on the block's first line, whatever its type size, rather than hanging from its top edge.
    const line = firstLine(current.dom, bounds);
    const y = Math.max(viewport.top + 2, Math.min(line - 12, viewport.bottom - 26));
    controls.style.setProperty("--folio-grip-width", `${gripWidth}px`);
    controls.style.width = `${width}px`;
    controls.style.left = `${x}px`;
    controls.style.top = `${y}px`;
    menu.position();
    if (current.node.type.name === "table") tableTools.position();
  }
  const schedule = () => {
    if (current && !frame) frame = requestAnimationFrame(position);
  };
  function show(view: EditorView, target: Node | null, active_fn: () => boolean, editable_fn: () => boolean) {
    if (!active_fn() || expanded()) return;
    const block = blockAtDOM(view, target);
    if (!block) return;
    const changed = current?.view !== view || current.position !== block.position || current.node !== block.node;
    if (changed) {
      unregister?.();
      const { node, position: at, dom } = block;
      const label = names[node.type.name] ?? "Block";
      const handle = {
        active_fn: () =>
          active_fn() &&
          dom.isConnected &&
          root.contains(view.dom) &&
          at < view.state.doc.content.size &&
          view.state.doc.nodeAt(at) === node &&
          view.nodeDOM(at) === dom,
        editable_fn,
        anchor_fn: () => grip,
        selected_fn: () =>
          view.state.doc === restoreDocument && restoreSelection !== null && view.state.selection.eq(restoreSelection),
        focus_fn: () => focusEditorView(view),
      };
      current = { ...block, view, handle };
      unregister = menu.register(grip, handle);
      grip.setAttribute("aria-label", `${label} actions`);
      grip.title = "Actions";
      grip.setAttribute("aria-controls", node.type.name === "table" ? "folio-table-tools" : toolbar.id);
      grip.dataset.blockType = node.type.name;
    }
    const hidden = controls.dataset.open !== "true";
    if (controls.parentElement !== root) root.append(controls);
    add.hidden = !editable_fn();
    add.disabled = !editable_fn();
    if (changed || hidden) {
      cancelAnimationFrame(frame);
      position();
    } else schedule();
    if (current) setToolVisibility(controls, true);
  }
  function open() {
    try {
      if (!current?.handle.active_fn()) throw new Error("Block is gone");
      const { view, node, position: at } = current;
      if (expanded()) {
        if (node.type.name === "table") tableTools.dismiss();
        else menu.dismiss();
        return;
      }
      if (!(view.state.selection instanceof CellSelection)) syncViewSelection(view);
      if (node.type.name === "table") {
        tableTools.openBlock(view, at, grip);
        return;
      }
      restoreSelection = view.state.selection;
      restoreDocument = view.state.doc;
      menu.open(grip);
      (actions.querySelector<HTMLButtonElement>("button:not(:disabled)") ?? toolbar).focus({ preventScroll: true });
    } catch (error) {
      onNotice?.(`Menu failed: ${errorMessage(error)}`, "error");
    }
  }
  lifetime.listen(toolbar, "keydown", (event) => {
    const options = [...actions.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    if (!options.length || !["ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    const index = options.findIndex((button) => button === document.activeElement);
    const direction = event.key === "ArrowDown" ? 1 : -1;
    options[(index + direction + options.length) % options.length].focus();
  });
  lifetime.listen(document, "pointerdown", (event) => {
    if (event.button !== 0 || closestElement(event.target, ".folio-block-controls, .folio-node-toolbar")) return;
    close();
    const dom = closestElement(event.target, ".ProseMirror");
    const owner = dom && views.get(dom);
    if (owner && event.target instanceof Node) show(owner.view, event.target, owner.active_fn, owner.editable_fn);
  });
  lifetime.listen(root, "dragstart", close);
  lifetime.listen(root, "scroll", schedule, true);
  lifetime.listen(root, "load", schedule, true);
  lifetime.listen(window, "resize", schedule);
  const resize = new ResizeObserver(schedule);
  lifetime.defer(() => resize.disconnect());
  resize.observe(root);
  lifetime.defer(close);
  return {
    close,
    refresh() {
      if (current && !current.handle.active_fn()) {
        close();
        return;
      }
      if (current) {
        add.hidden = !current.handle.editable_fn();
        add.disabled = !current.handle.editable_fn();
      }
      if (menu.target() && !current?.handle.selected_fn()) menu.close();
      menu.refresh();
      schedule();
    },
    plugin({ active_fn, editable_fn }: NodeActivity) {
      return $prose(
        () =>
          new Plugin({
            props: {
              handleKeyDown(view, event) {
                if (
                  event.key !== "ContextMenu" &&
                  !(event.key === "F10" && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey)
                )
                  return false;
                if (!active_fn() || event.isComposing || view.composing) return false;
                try {
                  if (!(view.state.selection instanceof CellSelection)) syncViewSelection(view);
                  const target =
                    view.nodeDOM(view.state.selection.from) ?? view.domAtPos(view.state.selection.from).node;
                  show(view, target, active_fn, editable_fn);
                  if (!current) return false;
                  event.preventDefault();
                  open();
                  return true;
                } catch (error) {
                  event.preventDefault();
                  onNotice?.(`Menu failed: ${errorMessage(error)}`, "error");
                  return true;
                }
              },
            },
            view(view) {
              views.set(view.dom, { view, active_fn, editable_fn });
              return {
                update() {
                  if (current?.view !== view) return;
                  if (!current.handle.active_fn()) {
                    close();
                    return;
                  }
                  if (menu.target() && !current.handle.selected_fn()) menu.close();
                  schedule();
                },
                destroy() {
                  views.delete(view.dom);
                  if (current?.view === view) {
                    close();
                    controls.remove();
                  }
                },
              };
            },
          }),
      );
    },
  };
}
