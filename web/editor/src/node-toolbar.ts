import { createIcon } from "./icons.ts";
import { normalizeSerializedBody } from "./roundtrip.ts";
import { createNodeInspector } from "./node-inspector.ts";
import type { Node as ProseNode } from "@milkdown/prose/model";
import { closestElement } from "./dom.ts";
import type { Lifetime } from "../../shared/lifetime.ts";
const activeToolbars = new WeakMap<HTMLElement, () => void>();
export function nodeMarkdown({
  node,
  document,
  serialize_fn,
}: {
  node: ProseNode;
  document: ProseNode;
  serialize_fn: (document: ProseNode) => string;
}) {
  const content = node.isInline ? document.type.schema.nodes.paragraph.create(null, node) : node;
  return normalizeSerializedBody(serialize_fn(document.type.create(null, content)));
}
export function toolButton({
  label,
  icon,
  text,
  onClick,
}: {
  label: string;
  icon?: string;
  text?: string;
  onClick: (event: MouseEvent) => void;
}) {
  const button = document.createElement("button");
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  if (icon) button.append(createIcon(icon));
  if (text) button.append(document.createTextNode(text));
  button.addEventListener("click", onClick);
  return button;
}
export function setToolVisibility(element: HTMLElement, visible: boolean) {
  element.dataset.open = String(visible);
  element.inert = !visible;
  element.setAttribute("aria-hidden", String(!visible));
}
export interface NodeToolHandle {
  active_fn: () => boolean;
  focus_fn?: () => void;
  reveal_fn?: () => void;
  anchor_fn?: () => Element;
  selected_fn?: () => boolean;
  trigger_fn?: () => HTMLElement;
}
type Placement = "outside" | "below-start" | "below-end" | "inside-top-end";
interface ToolbarOptions<Handle extends NodeToolHandle> {
  lifetime: Lifetime;
  root: HTMLElement;
  toolbar: HTMLElement;
  onShow: (handle: Handle) => void;
  onHide?: () => void;
  placement?: Placement | ((handle: Handle) => Placement);
  dock?: boolean;
  openOnHover?: boolean;
  role?: "toolbar" | "menu";
}
export function createNodeToolbar<Handle extends NodeToolHandle>({
  lifetime,
  root,
  toolbar,
  onShow,
  onHide,
  placement = "outside",
  dock = false,
  openOnHover = true,
  role = "toolbar",
}: ToolbarOptions<Handle>) {
  const targets = new WeakMap<HTMLElement, Handle>();
  let current: {
    dom: HTMLElement;
    handle: Handle;
  } | null = null;
  let timer: number | undefined;
  let frame = 0;
  toolbar.hidden = false;
  toolbar.tabIndex = -1;
  toolbar.classList.add("folio-node-toolbar");
  toolbar.setAttribute("role", role);
  setToolVisibility(toolbar, false);
  document.body.append(toolbar);
  lifetime.defer(() => toolbar.remove());
  const inspector = dock
    ? createNodeInspector({
        lifetime,
        root,
        panel: toolbar,
        allowSide: false,
        onResize_fn() {},
        onOpen_fn: () => target()?.reveal_fn?.(),
      })
    : null;
  if (dock) toolbar.dataset.noticeAvoid = "";
  function close() {
    window.clearTimeout(timer);
    cancelAnimationFrame(frame);
    timer = undefined;
    frame = 0;
    const opened = current !== null || toolbar.dataset.open === "true";
    current = null;
    if (!opened) return;
    setToolVisibility(toolbar, false);
    inspector?.setOpen(false);
    onHide?.();
    if (activeToolbars.get(root) === close) activeToolbars.delete(root);
  }
  function target() {
    if (!current) return null;
    if (!current.dom.isConnected || !current.handle.active_fn()) {
      close();
      return null;
    }
    return current.handle;
  }
  function dismiss() {
    const restore = target()?.focus_fn;
    close();
    restore?.();
  }
  function position() {
    frame = 0;
    const handle = target();
    if (!handle || !current) return;
    if (inspector) {
      inspector.refresh();
      return;
    }
    const layout = typeof placement === "function" ? placement(handle) : placement;
    const bounds = (handle.anchor_fn?.() ?? current.dom).getBoundingClientRect();
    const viewport = (root.querySelector("[data-editor-scroller]") ?? root).getBoundingClientRect();
    if (bounds.bottom <= viewport.top || bounds.top >= viewport.bottom || viewport.height <= 0) {
      close();
      return;
    }
    if (role === "menu") {
      const above = bounds.top - Math.max(8, viewport.top + 6) - 6;
      const below = Math.min(innerHeight, viewport.bottom) - bounds.bottom - 14;
      toolbar.style.maxHeight = `${Math.max(80, Math.min(innerHeight - 16, viewport.height - 16, Math.max(above, below)))}px`;
    }
    const { width, height } = toolbar.getBoundingClientRect();
    const origin =
      layout === "below-start" ? bounds.left : bounds.right - width - (layout === "inside-top-end" ? 6 : 0);
    const left = Math.max(8, Math.min(origin, innerWidth - width - 8));
    let top;
    if (layout === "inside-top-end") {
      if (bounds.height >= height * 2 + 12 && bounds.width >= width + 12)
        top = Math.max(viewport.top + 6, bounds.top + 6);
      else {
        const above = bounds.top - height - 6;
        top = above >= viewport.top + 6 ? above : bounds.bottom + 6;
      }
    } else if (layout === "below-start" || layout === "below-end") {
      top =
        bounds.bottom + 6 + height <= Math.min(innerHeight, viewport.bottom) - 8
          ? bounds.bottom + 6
          : Math.max(viewport.top + 6, bounds.top - height - 6);
    } else {
      const above = bounds.top - height - 6;
      const below = bounds.bottom + 6;
      top =
        above >= viewport.top + 6
          ? above
          : below + height <= Math.min(innerHeight, viewport.bottom) - 8
            ? below
            : Math.max(viewport.top + 6, above);
    }
    top = Math.max(8, Math.min(top, innerHeight - height - 8));
    toolbar.style.left = `${left}px`;
    toolbar.style.top = `${top}px`;
    for (const panel of toolbar.querySelectorAll<HTMLElement>("[data-node-panel]:not([hidden])")) {
      const panelWidth = panel.offsetWidth;
      const panelHeight = panel.offsetHeight;
      const panelLeft = Math.max(
        Math.max(8, viewport.left + 8),
        Math.min(left + width - panelWidth, innerWidth - panelWidth - 8),
      );
      const below = panel.dataset.nodePanel === "after-anchor" ? bounds.bottom + 6 : top + height + 5;
      const panelTop = below + panelHeight <= innerHeight - 8 ? below : Math.max(8, top - panelHeight - 5);
      panel.style.left = `${panelLeft - left}px`;
      panel.style.top = `${panelTop - top}px`;
    }
  }
  function schedule() {
    if (current && !frame) frame = requestAnimationFrame(position);
  }
  function enter(event: Pick<Event, "target">) {
    const dom = closestElement(event.target, "[data-folio-node-tool]");
    const handle = dom && root.contains(dom) ? targets.get(dom) : null;
    if (!dom || !handle?.active_fn()) return;
    window.clearTimeout(timer);
    timer = undefined;
    if (current?.dom === dom) return;
    const previous = activeToolbars.get(root);
    if (previous !== close) previous?.();
    activeToolbars.set(root, close);
    current = { dom, handle };
    onShow(handle);
    toolbar.hidden = false;
    inspector?.setOpen(true);
    position();
    if (current) setToolVisibility(toolbar, true);
  }
  function leave() {
    if (!current) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = undefined;
      if (
        !toolbar.matches(":hover") &&
        !current?.dom.matches(":hover") &&
        !toolbar.contains(document.activeElement) &&
        !current?.handle.selected_fn?.()
      )
        close();
    }, 140);
  }
  if (openOnHover) {
    lifetime.listen(root, "pointerover", enter);
    lifetime.listen(root, "focusin", enter);
  }
  lifetime.listen(root, "pointerout", leave);
  lifetime.listen(root, "focusout", leave);
  lifetime.listen(root, "scroll", schedule, true);
  lifetime.listen(root, "load", schedule, true);
  lifetime.listen(toolbar, "pointerenter", () => {
    window.clearTimeout(timer);
    timer = undefined;
  });
  lifetime.listen(toolbar, "pointerleave", leave);
  lifetime.listen(toolbar, "focusout", leave);
  lifetime.listen(window, "resize", schedule);
  lifetime.listen(document, "pointerdown", (event) => {
    if (closestElement(event.target, "[data-preserve-node-tools]")) return;
    const node = event.target instanceof Node ? event.target : null;
    if (role !== "menu" && root.contains(node) && current?.handle.selected_fn?.()) return;
    const trigger = role === "menu" ? (current?.handle.trigger_fn?.() ?? current?.dom) : current?.dom;
    if (current && trigger && !trigger.contains(node) && !toolbar.contains(node)) close();
  });
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented || !current || document.querySelector("dialog[open]")) return;
    event.preventDefault();
    dismiss();
  };
  lifetime.listen(toolbar, "keydown", escape);
  if (role === "menu") lifetime.listen(document, "keydown", escape);
  lifetime.defer(close);
  return {
    close,
    dismiss,
    target,
    position: schedule,
    open: (dom: HTMLElement) => enter({ target: dom }),
    refresh() {
      const handle = target();
      if (handle) {
        onShow(handle);
        schedule();
      }
    },
    register(dom: HTMLElement, handle: Handle) {
      dom.dataset.folioNodeTool = "";
      targets.set(dom, handle);
      return () => {
        targets.delete(dom);
        if (current?.dom === dom) close();
      };
    },
  };
}
