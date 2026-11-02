import { TextSelection, type EditorState } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import type { NodeActivity } from "./types/editor.ts";
import { nodeElement } from "./dom.ts";

const fontProperties = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontStretch",
  "fontVariantLigatures",
  "fontFeatureSettings",
  "fontVariationSettings",
  "fontOpticalSizing",
] as const;

export function createLiveCaret({
  view,
  root,
  active_fn,
  editable_fn,
}: NodeActivity & { view: EditorView; root: HTMLElement }) {
  const owner = view.dom.ownerDocument;
  if (!owner.defaultView) throw new Error("The live caret requires a browser document.");
  const window = owner.defaultView;
  const caret = owner.createElement("div");
  caret.className = "folio-live-caret";
  caret.setAttribute("aria-hidden", "true");
  caret.hidden = true;
  const probe = owner.createElement("span");
  probe.className = "folio-caret-metrics";
  probe.setAttribute("aria-hidden", "true");
  probe.textContent = "M";
  root.append(caret, probe);
  const range = owner.createRange();
  range.selectNodeContents(probe);
  let metric: { signature: string; height: number } | null = null;
  let frame = 0;
  let restart = true;
  let destroyed = false;

  function hide() {
    caret.hidden = true;
    view.dom.classList.remove("folio-font-caret");
  }

  function fontHeight(element: Element, text?: string) {
    const style = window.getComputedStyle(element);
    const sample = Array.from(text ?? "").at(-1);
    const glyph = sample && !/\s/.test(sample) ? sample : "M";
    const signature = [glyph, ...fontProperties.map((property) => style[property])].join("|");
    if (metric?.signature === signature) return metric.height;
    for (const property of fontProperties) probe.style[property] = style[property];
    probe.style.lineHeight = "normal";
    probe.textContent = glyph;
    range.selectNodeContents(probe);
    const height = range.getBoundingClientRect().height;
    metric = { signature, height };
    return height;
  }

  function visible(element: Element, x: number, top: number, bottom: number) {
    for (let parent: Element | null = element; parent; parent = parent.parentElement) {
      const style = window.getComputedStyle(parent);
      const bounds = parent.getBoundingClientRect();
      const left = bounds.left + parent.clientLeft;
      const y = bounds.top + parent.clientTop;
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX) && (x < left || x > left + parent.clientWidth))
        return false;
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY) && (bottom <= y || top >= y + parent.clientHeight))
        return false;
      if (parent === root) break;
    }
    return true;
  }

  function draw() {
    frame = 0;
    if (
      destroyed ||
      !active_fn() ||
      !editable_fn() ||
      !view.hasFocus() ||
      !(view.state.selection instanceof TextSelection) ||
      !view.state.selection.empty
    ) {
      hide();
      return;
    }
    const selection = owner.getSelection();
    if (!selection?.isCollapsed || !selection.focusNode || !view.dom.contains(selection.focusNode)) {
      hide();
      return;
    }
    const element = nodeElement(selection.focusNode);
    if (
      !element ||
      element.closest('[contenteditable="false"]') ||
      (view.state.selection.$head.parent.content.size && !view.state.selection.$head.parent.textContent)
    ) {
      hide();
      return;
    }
    const position = view.posAtDOM(selection.focusNode, selection.focusOffset);
    if (position < 0 || position > view.state.doc.content.size) {
      hide();
      return;
    }
    const native = selection.getRangeAt(0).getBoundingClientRect();
    const coordinates =
      native.height > 0 && selection.focusNode.nodeType === Node.TEXT_NODE ? native : view.coordsAtPos(position);
    const text =
      selection.focusNode.nodeType === Node.TEXT_NODE
        ? selection.focusNode.nodeValue?.slice(Math.max(0, selection.focusOffset - 2), selection.focusOffset)
        : view.state.doc.resolve(position).nodeBefore?.text;
    const height = fontHeight(element, text?.slice(-2));
    if (!height || coordinates.bottom <= coordinates.top) {
      hide();
      return;
    }
    const top = coordinates.top + (coordinates.bottom - coordinates.top - height) / 2;
    if (!visible(element, coordinates.left, top, top + height)) {
      hide();
      return;
    }
    const bounds = root.getBoundingClientRect();
    caret.style.transform = `translate(${coordinates.left - bounds.left}px, ${top - bounds.top}px)`;
    caret.style.height = `${height}px`;
    caret.hidden = false;
    view.dom.classList.add("folio-font-caret");
    if (restart) {
      for (const animation of caret.getAnimations()) animation.currentTime = 0;
      restart = false;
    }
  }

  function schedule() {
    if (!destroyed && !frame) frame = window.requestAnimationFrame(draw);
  }
  function wake() {
    restart = true;
    schedule();
  }
  function fontsChanged() {
    metric = null;
    schedule();
  }
  const events: [EventTarget | null, string, EventListener, boolean?][] = [
    [owner, "selectionchange", wake],
    [owner, "scroll", schedule, true],
    [window, "resize", schedule],
    [view.dom, "focus", wake],
    [view.dom, "blur", hide],
    [view.dom, "input", wake],
    [view.dom, "compositionupdate", wake],
    [view.dom, "compositionend", wake],
    [owner.fonts, "loadingdone", fontsChanged],
  ];
  for (const [target, type, listener, capture] of events) target?.addEventListener(type, listener, capture);
  const resize = new ResizeObserver(schedule);
  resize.observe(view.dom);
  resize.observe(root);
  const appearance = new MutationObserver(fontsChanged);
  appearance.observe(owner.documentElement, { attributes: true, attributeFilter: ["style", "data-theme"] });
  schedule();
  return {
    update(previous: EditorState) {
      if (!view.state.selection.eq(previous.selection) || !view.state.doc.eq(previous.doc)) restart = true;
      schedule();
    },
    destroy() {
      destroyed = true;
      window.cancelAnimationFrame(frame);
      for (const [target, type, listener, capture] of events) target?.removeEventListener(type, listener, capture);
      resize.disconnect();
      appearance.disconnect();
      hide();
      caret.remove();
      probe.remove();
    },
  };
}
