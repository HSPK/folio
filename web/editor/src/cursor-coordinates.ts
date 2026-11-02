import { TextSelection } from "@milkdown/prose/state";
import type { Selection } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import { isElement } from "./dom.ts";

interface SelectionView {
  state: { selection: Selection };
  dom: Pick<HTMLElement, "contains"> & { ownerDocument: Pick<Document, "getSelection"> };
  posAtDOM: EditorView["posAtDOM"];
}

export function currentViewSelection(view: SelectionView) {
  if (!(view.state.selection instanceof TextSelection)) return view.state.selection;
  const selection = view.dom.ownerDocument.getSelection();
  if (
    selection?.anchorNode &&
    selection.focusNode &&
    view.dom.contains(selection.anchorNode) &&
    view.dom.contains(selection.focusNode)
  ) {
    return {
      anchor: view.posAtDOM(selection.anchorNode, selection.anchorOffset),
      head: view.posAtDOM(selection.focusNode, selection.focusOffset),
    };
  }
  return view.state.selection;
}

export function syncViewSelection(view: EditorView) {
  let current = currentViewSelection(view);
  const dom = view.dom.ownerDocument.getSelection();
  // Pointer selections can reach the DOM before the editor's selectionchange.
  if (dom?.isCollapsed && dom.anchorNode && view.dom.contains(dom.anchorNode)) {
    const position = view.posAtDOM(dom.anchorNode, dom.anchorOffset);
    if (view.state.doc.resolve(position).parent.isTextblock) current = { anchor: position, head: position };
  }
  if (current.anchor !== view.state.selection.anchor || current.head !== view.state.selection.head) {
    view.dispatch(
      view.state.tr
        .setSelection(
          TextSelection.between(view.state.doc.resolve(current.anchor), view.state.doc.resolve(current.head)),
        )
        .setMeta("addToHistory", false),
    );
  }
}

export function focusEditorView(view: EditorView, selection: Selection | null = null) {
  const positions = new Map<Element, { top: number; left: number }>();
  const capture = (node: Node) => {
    for (let element = isElement(node) ? node : node.parentElement; element; element = element.parentElement) {
      if (!positions.has(element)) positions.set(element, { top: element.scrollTop, left: element.scrollLeft });
    }
  };
  capture(view.dom);
  for (const range of [view.state.selection, selection]) {
    if (!range) continue;
    capture(view.domAtPos(range.anchor).node);
    capture(view.domAtPos(range.head).node);
  }
  if (view.dom.ownerDocument.scrollingElement) capture(view.dom.ownerDocument.scrollingElement);
  try {
    if (selection && !selection.eq(view.state.selection)) {
      view.dispatch(view.state.tr.setSelection(selection).setMeta("addToHistory", false));
    }
    // Restoring the DOM selection can scroll even when focus itself prevents it.
    view.focus();
  } finally {
    for (const [element, { top, left }] of positions) {
      if (element.scrollTop !== top) element.scrollTop = top;
      if (element.scrollLeft !== left) element.scrollLeft = left;
    }
  }
}

export function textareaCursorRect(textarea: HTMLTextAreaElement, position: number) {
  const bounds = textarea.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return null;
  const style = getComputedStyle(textarea);
  const mirror = document.createElement("div");
  Object.assign(mirror.style, {
    position: "fixed",
    top: `${bounds.top}px`,
    left: `${bounds.left}px`,
    width: `${textarea.clientWidth}px`,
    boxSizing: "border-box",
    visibility: "hidden",
    whiteSpace: textarea.wrap === "off" ? "pre" : "pre-wrap",
    overflowWrap: "break-word",
    font: style.font,
    letterSpacing: style.letterSpacing,
    tabSize: style.tabSize,
    padding: style.padding,
    border: "0",
    pointerEvents: "none",
  });
  mirror.textContent = textarea.value.slice(0, position);
  const span = document.createElement("span");
  span.textContent = textarea.value.slice(position) || "\u200b";
  mirror.append(span);
  document.body.append(mirror);
  try {
    const rect = span.getClientRects()[0] ?? span.getBoundingClientRect();
    const top = rect.top - textarea.scrollTop + textarea.clientTop;
    const left = rect.left - textarea.scrollLeft + textarea.clientLeft;
    return { top, bottom: top + parseFloat(style.lineHeight), left, right: left };
  } finally {
    mirror.remove();
  }
}
export function lineColumn(source: string, position: number) {
  const lines = source.slice(0, position).split(/\r\n|\r|\n/);
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

export function rawOffset(raw: string, normalizedOffset: number) {
  let position = 0;
  let normalized = 0;
  while (position < raw.length && normalized < normalizedOffset) {
    position += raw[position] === "\r" && raw[position + 1] === "\n" ? 2 : 1;
    normalized++;
  }
  return position;
}

export function jumpToHeading(view: EditorView, headingId: string, block: ScrollLogicalPosition = "nearest") {
  let id = headingId.replace(/^#/, "");
  try {
    id = decodeURIComponent(id);
  } catch {
    // Literal percent signs remain valid IDs.
  }
  const target = view.dom.querySelector(`#${CSS.escape(id)}`);
  if (!target?.matches("h1, h2, h3, h4, h5, h6")) return false;
  const position = view.posAtDOM(target, 0);
  view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(position))));
  view.focus();
  target.scrollIntoView({ block, behavior: "instant" });
  return true;
}

export function textareaOffsetAtPoint(textarea: HTMLTextAreaElement, x: number, y: number) {
  const bounds = textarea.getBoundingClientRect();
  const style = getComputedStyle(textarea);
  const mirror = document.createElement("div");
  mirror.contentEditable = "true";
  Object.assign(mirror.style, {
    position: "fixed",
    top: `${bounds.top - textarea.scrollTop}px`,
    left: `${bounds.left - textarea.scrollLeft}px`,
    width: `${textarea.clientWidth}px`,
    boxSizing: "border-box",
    opacity: "0",
    zIndex: "2147483647",
    whiteSpace: textarea.wrap === "off" ? "pre" : "pre-wrap",
    overflowWrap: "break-word",
    font: style.font,
    lineHeight: style.lineHeight,
    letterSpacing: style.letterSpacing,
    tabSize: style.tabSize,
    padding: style.padding,
    border: "0",
  });
  const text = document.createTextNode(textarea.value || "\u200b");
  mirror.append(text);
  document.body.append(mirror);
  try {
    const position = document.caretPositionFromPoint?.(x, y);
    if (position?.offsetNode === text) return Math.min(textarea.value.length, position.offset);
    const range = document.caretRangeFromPoint?.(x, y);
    return range?.startContainer === text ? Math.min(textarea.value.length, range.startOffset) : textarea.value.length;
  } finally {
    mirror.remove();
  }
}
