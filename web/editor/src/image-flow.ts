import { Plugin, NodeSelection, TextSelection, type EditorState } from "@milkdown/prose/state";
import { GapCursor, gapCursor } from "@milkdown/prose/gapcursor";
import { dropCursor } from "@milkdown/prose/dropcursor";
import { canSplit } from "@milkdown/prose/transform";
import { closeHistory } from "@milkdown/prose/history";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/prose/view";
import type { Node as ProseNode } from "@milkdown/prose/model";
import type { NodeActivity } from "./types/editor.ts";
import { closestElement } from "./dom.ts";
import {
  imageBoundarySelection,
  imageMoveTransaction,
  imageRemovalTransaction,
  imageRowCount,
  imageRowTarget,
  imageRowTransaction,
  isImageNode,
} from "./image-model.ts";

export function imageKeyTransaction(state: EditorState, key: string) {
  const selection = state.selection;
  const selected = selection instanceof NodeSelection && isImageNode(selection.node);
  const gap = selection instanceof GapCursor;
  if (selected && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(key)) {
    const direction = ["ArrowLeft", "ArrowUp"].includes(key) ? -1 : 1;
    const position = direction < 0 ? selection.from : selection.to;
    const next = selection.node.isInline
      ? TextSelection.create(state.doc, position)
      : imageBoundarySelection(state.doc, position, direction);
    return state.tr.setSelection(next).scrollIntoView();
  }
  if (key === "Enter" && (selected || gap)) {
    const transaction = closeHistory(state.tr);
    if (selected && selection.node.isInline) {
      if (!canSplit(state.doc, selection.to)) return null;
      transaction.split(selection.to);
      return transaction.setSelection(TextSelection.create(transaction.doc, selection.to + 2)).scrollIntoView();
    }
    const position = selected ? selection.to : selection.from;
    const paragraph = state.schema.nodes.paragraph.create();
    const resolved = state.doc.resolve(position);
    if (!resolved.parent.canReplaceWith(resolved.index(), resolved.index(), paragraph.type)) return null;
    transaction.insert(position, paragraph);
    return transaction.setSelection(TextSelection.create(transaction.doc, position + 1)).scrollIntoView();
  }
  if (!["Backspace", "Delete"].includes(key)) return null;
  if (selected) return imageRemovalTransaction(state, selection.from);
  if (!selection.empty || !(selection instanceof TextSelection || gap)) return null;
  const backwards = key === "Backspace";
  const resolved = selection.$from;
  let position = selection.from;
  let image = backwards ? resolved.nodeBefore : resolved.nodeAfter;
  if (
    !isImageNode(image) &&
    resolved.parent.isTextblock &&
    resolved.parentOffset === (backwards ? 0 : resolved.parent.content.size) &&
    resolved.depth
  ) {
    position = backwards ? resolved.before() : resolved.after();
    const boundary = state.doc.resolve(position);
    image = backwards ? boundary.nodeBefore : boundary.nodeAfter;
  }
  if (!isImageNode(image)) return null;
  if (backwards) position -= image.nodeSize;
  return state.tr.setSelection(NodeSelection.create(state.doc, position)).scrollIntoView();
}

function draggingImage(view: EditorView) {
  if (!view.dragging) return null;
  const selection = "node" in view.dragging ? (view.dragging.node ?? view.state.selection) : view.state.selection;
  if (!(selection instanceof NodeSelection) || !isImageNode(selection.node)) return null;
  const node = view.state.doc.nodeAt(selection.from);
  return isImageNode(node) && node.eq(selection.node) ? { from: selection.from, node } : null;
}

interface ImageDropTarget {
  element: HTMLElement;
  position: number;
  direction: number;
  row: { to: number; after: boolean } | null;
}

function imageDropTarget(
  view: EditorView,
  event: Pick<MouseEvent, "target" | "clientX" | "clientY">,
  source: ReturnType<typeof draggingImage> = null,
) {
  const element = closestElement(event.target, ".folio-inline-image");
  const positions = new Set<number>();
  if (element && view.dom.contains(element)) positions.add(view.posAtDOM(element, 0));
  const point = source && view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (point) {
    const resolved = view.state.doc.resolve(point.pos);
    positions.add(point.inside);
    // Whitespace maps to adjacent blocks, not necessarily the image under its row.
    for (let depth = resolved.depth; depth >= 0; depth--) {
      const parent = resolved.node(depth);
      const index = resolved.index(depth);
      for (const candidate of new Set([index - 1, index])) {
        if (candidate < 0 || candidate >= parent.childCount) continue;
        const node = parent.child(candidate);
        const position = resolved.posAtIndex(candidate, depth);
        if (isImageNode(node)) positions.add(position);
        else if (node.type.name === "paragraph")
          node.forEach((child, offset) => {
            if (isImageNode(child)) positions.add(position + 1 + offset);
          });
      }
    }
  }
  let nearest: ImageDropTarget | null = null;
  let distance = Infinity;
  for (const position of positions) {
    if (position < 0 || position === source?.from) continue;
    const image = view.state.doc.nodeAt(position);
    if (!isImageNode(image)) continue;
    const anchor = view.nodeDOM(position);
    if (!(anchor instanceof HTMLElement)) continue;
    const bounds = anchor.getBoundingClientRect();
    if (!anchor.parentElement) continue;
    const parent = anchor.parentElement.getBoundingClientRect();
    const edge = Math.min(64, bounds.width * 0.3);
    const inset = Math.min(24, bounds.height * 0.2);
    const beside =
      source &&
      imageRowTarget(view.state.doc, position) &&
      event.clientY > bounds.top + inset &&
      event.clientY < bounds.bottom - inset &&
      event.clientX >= parent.left - 12 &&
      event.clientX <= parent.right + 12 &&
      (event.clientX < bounds.left + edge || event.clientX > bounds.right - edge);
    const inside =
      event.clientX >= bounds.left &&
      event.clientX <= bounds.right &&
      event.clientY >= bounds.top &&
      event.clientY <= bounds.bottom;
    if (!inside && !beside) continue;
    const gap = Math.max(0, bounds.left - event.clientX, event.clientX - bounds.right);
    if (gap >= distance) continue;
    const after = image.isBlock
      ? event.clientY >= bounds.top + bounds.height / 2
      : event.clientX >= bounds.left + bounds.width / 2;
    nearest = {
      element: anchor,
      position: position + (after ? image.nodeSize : 0),
      direction: after ? 1 : -1,
      row: beside ? { to: position, after: event.clientX >= bounds.left + bounds.width / 2 } : null,
    };
    distance = gap;
  }
  return nearest;
}

function imageWhitespaceSelection(view: EditorView, event: MouseEvent) {
  if (event.target !== view.dom) return null;
  const point = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (!point) return null;
  const resolved = view.state.doc.resolve(point.pos);
  const positions = [
    point.inside,
    point.pos,
    ...(isImageNode(resolved.nodeBefore) ? [point.pos - resolved.nodeBefore.nodeSize] : []),
  ];
  for (const position of new Set(positions)) {
    if (position < 0) continue;
    const image = view.state.doc.nodeAt(position);
    if (!isImageNode(image) || !image.isBlock) continue;
    const element = view.nodeDOM(position);
    if (!(element instanceof HTMLElement)) continue;
    const bounds = element.getBoundingClientRect();
    const before = event.clientY < bounds.top || (event.clientY <= bounds.bottom && event.clientX < bounds.left);
    return imageBoundarySelection(view.state.doc, position + (before ? 0 : image.nodeSize), before ? -1 : 1);
  }
  return null;
}

export function imageSelectionAtPoint(view: EditorView, { x, y }: { x: number; y: number }) {
  const target = view.dom.ownerDocument.elementFromPoint(x, y);
  const image = target && imageDropTarget(view, { target, clientX: x, clientY: y });
  if (image) return imageBoundarySelection(view.state.doc, image.position, image.direction);
  const point = view.posAtCoords({ left: x, top: y });
  return point ? imageBoundarySelection(view.state.doc, point.pos) : null;
}

export function createImageFlowPlugins({ active_fn, editable_fn }: NodeActivity) {
  const rows = new WeakMap<ProseNode, DecorationSet>();
  let dropTarget: { element: HTMLElement; view: EditorView } | null = null;
  const clearDropTarget = () => {
    if (dropTarget) {
      delete dropTarget.element.dataset.imageDrop;
      delete dropTarget.view.dom.dataset.imageRowDrop;
    }
    dropTarget = null;
  };
  return [
    new Plugin({
      props: {
        decorations(state) {
          if (rows.has(state.doc)) return rows.get(state.doc);
          const decorations: Decoration[] = [];
          state.doc.descendants((node, position) => {
            const count = imageRowCount(node);
            if (count)
              decorations.push(
                Decoration.node(position, position + node.nodeSize, {
                  class: "folio-image-row",
                  style: `--folio-image-row-count:${count}`,
                }),
              );
          });
          const result = DecorationSet.create(state.doc, decorations);
          rows.set(state.doc, result);
          return result;
        },
        handleDOMEvents: {
          beforeinput(view, event) {
            if (
              !active_fn() ||
              !editable_fn() ||
              !(view.state.selection instanceof GapCursor) ||
              view.composing ||
              event.isComposing
            )
              return false;
            const selection = view.dom.ownerDocument.getSelection();
            if (
              !selection?.isCollapsed ||
              !selection.anchorNode ||
              !view.dom.contains(selection.anchorNode) ||
              view.posAtDOM(selection.anchorNode, selection.anchorOffset) !== view.state.selection.from
            )
              return false;
            let transaction = null;
            if (
              ["insertText", "insertReplacementText"].includes(event.inputType) &&
              typeof event.data === "string" &&
              event.data.length
            ) {
              transaction = closeHistory(view.state.tr).insertText(event.data).scrollIntoView();
            } else if (["insertParagraph", "insertLineBreak"].includes(event.inputType)) {
              transaction = imageKeyTransaction(view.state, "Enter");
            }
            if (!transaction) return false;
            event.preventDefault();
            view.dispatch(transaction);
            return true;
          },
          mousedown(view, event) {
            if (
              !active_fn() ||
              event.button !== 0 ||
              event.shiftKey ||
              event.metaKey ||
              event.ctrlKey ||
              event.altKey ||
              closestElement(event.target, ".folio-image-resize")
            )
              return false;
            const selection = editable_fn() ? imageWhitespaceSelection(view, event) : null;
            if (!selection) return false;
            event.preventDefault();
            view.dispatch(view.state.tr.setSelection(selection));
            view.focus();
            return true;
          },
          dragover(view, event) {
            if (!active_fn() || !editable_fn()) {
              clearDropTarget();
              return false;
            }
            const source = draggingImage(view);
            const target = source && imageDropTarget(view, event, source);
            if (!target?.row) {
              clearDropTarget();
              return false;
            }
            const direction = target.row.after ? "after" : "before";
            if (dropTarget?.element === target.element && target.element.dataset.imageDrop === direction) return false;
            clearDropTarget();
            dropTarget = { element: target.element, view };
            target.element.dataset.imageDrop = direction;
            view.dom.dataset.imageRowDrop = "";
            return false;
          },
          dragleave(view, event) {
            if (!(event.relatedTarget instanceof Node) || !view.dom.contains(event.relatedTarget)) clearDropTarget();
            return false;
          },
          dragend() {
            clearDropTarget();
            return false;
          },
        },
        handleClickOn(view, _position, node, nodePosition, event, direct) {
          if (!direct || !active_fn() || !isImageNode(node) || event.button !== 0) return false;
          view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, nodePosition)));
          view.focus();
          return true;
        },
        handleKeyDown(view, event) {
          if (
            !active_fn() ||
            !editable_fn() ||
            view.composing ||
            event.isComposing ||
            event.metaKey ||
            event.ctrlKey ||
            event.altKey ||
            event.shiftKey
          )
            return false;
          const transaction = imageKeyTransaction(view.state, event.key);
          if (!transaction) return false;
          view.dispatch(transaction);
          return true;
        },
        handleDrop(view, event, _slice, moved) {
          clearDropTarget();
          if (!active_fn() || !editable_fn()) return false;
          const source = draggingImage(view);
          if (!source) return false;
          const target = imageDropTarget(view, event, source);
          const position = target?.position ?? view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
          if (position == null) return false;
          const transaction = target?.row
            ? imageRowTransaction(view.state, { from: source.from, ...target.row, copy: !moved })
            : imageMoveTransaction(view.state, { from: source.from, to: position, copy: !moved });
          if (transaction) {
            view.dispatch(transaction.setMeta("uiEvent", "drop"));
            view.focus();
          }
          return true;
        },
      },
      view: () => ({ destroy: clearDropTarget }),
    }),
    gapCursor(),
    dropCursor({ color: "var(--focus, #70899c)", width: 2 }),
  ];
}
