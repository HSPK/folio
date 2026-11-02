import { Plugin, type Selection } from "@milkdown/prose/state";
import type { Node as ProseNode } from "@milkdown/prose/model";
import type { EditorView } from "@milkdown/prose/view";
import { CellSelection } from "@milkdown/prose/tables";
import { $prose } from "@milkdown/utils";
import { createNodeToolbar, setToolVisibility, toolButton } from "./node-toolbar.ts";
import { blockActionTransaction } from "./line-keymap.ts";
import { focusEditorView, syncViewSelection } from "./cursor-coordinates.ts";
import { closestElement, nodeElement } from "./dom.ts";
import { errorMessage } from "./errors.ts";
import type { CursorRect, InlineEditorOptions, NodeActivity } from "./types/editor.ts";
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
  label_fn: () => string;
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
  corridor?: CursorRect;
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
  const heading = document.createElement("div");
  heading.className = "folio-block-menu-heading";
  heading.setAttribute("role", "presentation");
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
  let timer = 0;
  let frame = 0;
  let restoreSelection: Selection | null = null;
  let restoreDocument: ProseNode | null = null;
  const controls = document.createElement("div");
  lifetime.defer(() => controls.remove());
  controls.className = "folio-block-controls";
  controls.setAttribute("role", "group");
  controls.setAttribute("aria-label", "Block controls");
  setToolVisibility(controls, false);
  const add = toolButton({
    label: "Add block below",
    icon: "plus",
    onClick() {
      try {
        if (!current?.handle.active_fn() || !current.handle.editable_fn())
          throw new Error("Select an editable block first.");
        const { view, position } = current;
        const transaction = blockActionTransaction(view.state, { position, action: "insert" });
        close();
        view.dispatch(transaction);
        view.focus();
        onNotice?.("");
      } catch (error) {
        onNotice?.(`Could not add block: ${errorMessage(error)}`, "error");
      }
    },
  });
  add.className = "folio-block-add";
  const grip = toolButton({ label: "Block actions", icon: "grip", onClick: open });
  grip.className = "folio-block-grip";
  grip.setAttribute("aria-haspopup", "menu");
  grip.setAttribute("aria-expanded", "false");
  controls.append(add, grip);
  lifetime.listen(controls, "pointerdown", (event) => event.preventDefault());
  for (const [action, label, icon] of [
    ["duplicate", "Duplicate block", "copy"],
    ["delete", "Delete block", "trash"],
  ]) {
    const button = toolButton({
      label,
      text: label,
      icon,
      onClick() {
        try {
          const target = menu.target();
          if (!target?.editable_fn() || !current) throw new Error("Select an editable block first.");
          const { view, position } = current;
          const transaction = blockActionTransaction(view.state, { position, action });
          close();
          view.dispatch(transaction);
          view.focus();
          onNotice?.("");
        } catch (error) {
          onNotice?.(`Could not edit block: ${errorMessage(error)}`, "error");
        }
      },
    });
    button.setAttribute("role", "menuitem");
    button.dataset.blockAction = action;
    actions.append(button);
  }
  toolbar.append(heading, actions);
  const menu = createNodeToolbar<BlockHandle>({
    lifetime,
    root,
    toolbar,
    role: "menu",
    placement: "below-start",
    openOnHover: false,
    onShow(target) {
      heading.textContent = target.label_fn();
      grip.setAttribute("aria-expanded", "true");
      for (const button of actions.querySelectorAll("button")) button.disabled = !target.editable_fn();
    },
    onHide() {
      grip.setAttribute("aria-expanded", "false");
      hideLater();
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
    clearTimeout(timer);
    cancelAnimationFrame(frame);
    timer = frame = 0;
  }
  function hideLater() {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = 0;
      if (!expanded() && !controls.matches(":hover, :focus-within") && !current?.dom.matches(":hover")) close();
    }, 160);
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
    const gripWidth = Math.min(18, Math.max(14, left - viewport.left - 36));
    const width = gripWidth * 2 + 8;
    const x = Math.max(viewport.left + 1, left - width - 8);
    const y = Math.max(viewport.top + 2, Math.min(bounds.top + 2, viewport.bottom - 28));
    controls.style.setProperty("--folio-grip-width", `${gripWidth}px`);
    controls.style.width = `${width}px`;
    controls.style.left = `${x}px`;
    controls.style.top = `${y}px`;
    current.corridor = { left: x - 2, right: Math.max(bounds.left, x + width), top: y - 4, bottom: y + 30 };
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
    clearTimeout(timer);
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
        label_fn: () => label,
        anchor_fn: () => grip,
        selected_fn: () =>
          view.state.doc === restoreDocument && restoreSelection !== null && view.state.selection.eq(restoreSelection),
        focus_fn: () => focusEditorView(view),
      };
      current = { ...block, view, handle };
      unregister = menu.register(grip, handle);
      grip.setAttribute("aria-label", `${label} actions`);
      grip.title = `${label} actions`;
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
      if (!current?.handle.active_fn()) throw new Error("This block is no longer open.");
      const { view, node, position: at } = current;
      clearTimeout(timer);
      if (expanded()) {
        if (node.type.name === "table") tableTools.dismiss();
        else menu.dismiss();
        return;
      }
      if (!(view.state.selection instanceof CellSelection)) syncViewSelection(view);
      if (node.type.name === "table") {
        tableTools.openBlock(view, at, grip, hideLater);
        return;
      }
      restoreSelection = view.state.selection;
      restoreDocument = view.state.doc;
      menu.open(grip);
      (actions.querySelector<HTMLButtonElement>("button:not(:disabled)") ?? toolbar).focus({ preventScroll: true });
    } catch (error) {
      onNotice?.(`Could not open block menu: ${errorMessage(error)}`, "error");
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
  lifetime.listen(controls, "pointerenter", () => clearTimeout(timer));
  lifetime.listen(controls, "pointerleave", hideLater);
  lifetime.listen(controls, "focusin", () => clearTimeout(timer));
  lifetime.listen(controls, "focusout", hideLater);
  const hover = (event: PointerEvent) => {
    if (current && !current.handle.active_fn()) close();
    const corridor = current?.corridor;
    if (
      corridor &&
      event.clientX >= corridor.left &&
      event.clientX <= corridor.right &&
      event.clientY >= corridor.top &&
      event.clientY <= corridor.bottom
    ) {
      clearTimeout(timer);
      return;
    }
    const dom = closestElement(event.target, ".ProseMirror");
    const owner = dom && views.get(dom);
    if (owner && event.target instanceof Node) show(owner.view, event.target, owner.active_fn, owner.editable_fn);
  };
  lifetime.listen(root, "pointerover", hover);
  lifetime.listen(root, "pointermove", hover);
  lifetime.listen(root, "pointerout", hideLater);
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
                  onNotice?.(`Could not open block menu: ${errorMessage(error)}`, "error");
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
