import { Fragment, type Node } from "@milkdown/prose/model";
import { NodeSelection, Plugin, Selection, TextSelection, type EditorState } from "@milkdown/prose/state";
import { closeHistory } from "@milkdown/prose/history";
import { $prose } from "@milkdown/utils";
import { syncViewSelection } from "./cursor-coordinates.ts";
import { childFragment } from "./prose-content.ts";
import { errorMessage } from "./errors.ts";
import type { InlineEditorOptions } from "./types/editor.ts";

export interface LineOperation {
  action: string;
  direction?: number;
}

type ShortcutEvent = Pick<KeyboardEvent, "key"> &
  Partial<
    Pick<KeyboardEvent, "code" | "isComposing" | "defaultPrevented" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">
  >;
type TextPiece = { from: number; to: number; text?: never } | { text: string; from?: never; to?: never };

export function lineShortcut(event: ShortcutEvent): LineOperation | null {
  if (event.isComposing || event.defaultPrevented) return null;
  const primary = event.metaKey || event.ctrlKey;
  if (event.altKey && !primary && ["ArrowUp", "ArrowDown"].includes(event.key)) {
    return { action: event.shiftKey ? "copy" : "move", direction: event.key === "ArrowUp" ? -1 : 1 };
  }
  if (!primary || event.altKey) return null;
  if (event.shiftKey && (event.key.toLowerCase() === "k" || event.code === "KeyK")) return { action: "delete" };
  if (event.key === "Enter") return { action: "insert", direction: event.shiftKey ? -1 : 1 };
  if (!event.shiftKey && (event.key.toLowerCase() === "l" || event.code === "KeyL")) return { action: "select" };
  return null;
}

export function textLineEdit(
  text: string,
  { anchor, head }: { anchor: number; head: number },
  { action, direction = 1 }: LineOperation,
) {
  const lines: { from: number; to: number; next: number }[] = [];
  let start = 0;
  for (const match of text.matchAll(/\r\n|\r|\n/g)) {
    lines.push({ from: start, to: match.index, next: match.index + match[0].length });
    start = match.index + match[0].length;
  }
  lines.push({ from: start, to: text.length, next: text.length });
  const lineAt = (position: number): number => {
    let index = 0;
    while (index + 1 < lines.length && lines[index + 1].from <= position) index++;
    return index;
  };
  const first = lineAt(Math.min(anchor, head));
  const last = lineAt(Math.max(anchor, head) - (anchor === head || action === "select" ? 0 : 1));
  const before = lines[first];
  const after = lines[last];
  const block = { from: before.from, to: after.to };
  const separator = lines.find((line) => line.next > line.to);
  const newline =
    after.next > after.to
      ? { from: after.to, to: after.next }
      : separator
        ? { from: separator.to, to: separator.next }
        : { text: "\n" };
  const length = (part: TextPiece) => (part.text !== undefined ? part.text.length : part.to - part.from);
  let from = block.from;
  let to = block.to;
  let parts: TextPiece[] = [];
  let delta = 0;
  if (action === "select") return { from, to, insert: null, parts: null, anchor: from, head: after.next };
  if (action === "delete") {
    if (after.next > after.to) to = after.next;
    else if (first > 0) from = lines[first - 1].to;
    anchor = head = from;
  } else if (action === "move") {
    if ((direction < 0 && first === 0) || (direction > 0 && last === lines.length - 1)) return null;
    if (direction < 0) {
      const previous = lines[first - 1];
      from = previous.from;
      parts = [block, { from: previous.to, to: previous.next }, { from: previous.from, to: previous.to }];
      delta = from - block.from;
    } else {
      const next = lines[last + 1];
      to = next.to;
      parts = [{ from: next.from, to: next.to }, { from: after.to, to: after.next }, block];
      delta = next.to - next.from + after.next - after.to;
    }
  } else if (action === "copy") {
    from = to = direction < 0 ? block.from : block.to;
    parts = direction < 0 ? [block, newline] : [newline, block];
    delta = direction < 0 ? 0 : block.to - block.from + length(newline);
  } else if (action === "insert") {
    const line = direction < 0 ? before : after;
    const indentation = text.slice(line.from, line.to).match(/^[ \t]*/)?.[0].length ?? 0;
    const indent = { from: line.from, to: line.from + indentation };
    from = to = direction < 0 ? line.from : line.to;
    parts = direction < 0 ? [indent, newline] : [newline, indent];
    anchor = head = from + indentation + (direction < 0 ? 0 : length(newline));
  } else throw new Error("This line editing action is unavailable.");
  const insert = parts.map((part) => part.text ?? text.slice(part.from, part.to)).join("");
  if (from === to && !insert) return null;
  return { from, to, insert, parts, anchor: anchor + delta, head: head + delta };
}

function inlineText(node: Node) {
  let text = "";
  node.forEach((child) => {
    // Opaque inline nodes keep their ProseMirror offsets without losing content.
    text += child.isText ? child.text : child.type.name === "hardbreak" ? "\n" : "\ufffc".repeat(child.nodeSize);
  });
  return text;
}

function inlineTransaction(state: EditorState, operation: LineOperation) {
  const { selection } = state;
  const node = selection.$from.parent;
  const text = inlineText(node);
  const plan = textLineEdit(
    text,
    { anchor: selection.anchor - selection.$from.start(), head: selection.head - selection.$from.start() },
    operation,
  );
  if (!plan) return null;
  const position = selection.$from.start();
  const transaction = closeHistory(state.tr);
  if (plan.parts) {
    let content = Fragment.empty;
    for (const part of plan.parts) {
      const fragment =
        part.text === undefined
          ? node.content.cut(part.from, part.to)
          : node.type.name === "code_block"
            ? Fragment.from(state.schema.text(part.text))
            : Fragment.from(state.schema.nodes.hardbreak.create());
      content = content.append(fragment);
    }
    transaction.replaceWith(position + plan.from, position + plan.to, content);
  }
  return transaction
    .setSelection(TextSelection.create(transaction.doc, position + plan.anchor, position + plan.head))
    .scrollIntoView();
}

function blockRange(state: EditorState) {
  const { $from, $to, empty } = state.selection;
  if (!$from.depth) {
    if (empty && !(state.selection instanceof NodeSelection)) return null;
    const first = $from.index();
    const last = state.selection instanceof NodeSelection ? first : state.doc.childCount - 1;
    return { parent: state.doc, first, last, from: state.selection.from, to: state.selection.to };
  }
  let depth = $from.depth;
  while (depth && !$from.node(depth).isBlock) depth--;
  for (let index = depth; index > 0; index--) {
    if ($from.node(index).type.name === "list_item") {
      depth = index;
      break;
    }
  }
  while (depth && (depth > $to.depth || $from.node(depth - 1) !== $to.node(depth - 1))) depth--;
  if (!depth)
    return { parent: state.doc, first: 0, last: state.doc.childCount - 1, from: 0, to: state.doc.content.size };
  const parent = $from.node(depth - 1);
  const first = $from.index(depth - 1);
  let last = $to.index(depth - 1);
  if ($to.parent.isTextblock && $to.parentOffset === 0 && $to.depth === depth && last > first) last--;
  const from = $from.before(depth);
  let to = from;
  for (let index = first; index <= last; index++) to += parent.child(index).nodeSize;
  return { parent, first, last, from, to };
}

function movedSelection(selection: Selection, document: Node, delta: number) {
  return selection instanceof NodeSelection
    ? NodeSelection.create(document, selection.from + delta)
    : selection instanceof TextSelection
      ? TextSelection.create(document, selection.anchor + delta, selection.head + delta)
      : TextSelection.between(document.resolve(selection.anchor + delta), document.resolve(selection.head + delta));
}

export function richLineTransaction(state: EditorState, operation: LineOperation) {
  const { selection } = state;
  const node = selection.$from.parent;
  if (selection instanceof TextSelection && selection.$from.sameParent(selection.$to) && node.isTextblock) {
    const text = inlineText(node);
    const role = selection.$from.depth > 1 ? selection.$from.node(-1).type.spec.tableRole : undefined;
    const fixed = selection.$from.depth > 1 && (role === "cell" || role === "header_cell");
    if (
      node.type.name === "code_block" ||
      fixed ||
      operation.action === "select" ||
      (operation.action !== "insert" && /[\r\n]/.test(text))
    )
      return inlineTransaction(state, operation);
  }
  return editBlocks(state, operation, selection, blockRange(state));
}

export function blockActionTransaction(state: EditorState, { position, action }: { position: number; action: string }) {
  const node =
    Number.isInteger(position) && position >= 0 && position < state.doc.content.size
      ? state.doc.nodeAt(position)
      : null;
  if (!node?.isBlock) throw new Error("This block is no longer editable.");
  if (!["duplicate", "delete", "insert"].includes(action)) throw new Error("This block action is unavailable.");
  const selection = NodeSelection.create(state.doc, position);
  const { parent } = selection.$from;
  const first = selection.$from.index();
  const transaction = editBlocks(state, { action: action === "duplicate" ? "copy" : action, direction: 1 }, selection, {
    parent,
    first,
    last: first,
    from: position,
    to: position + node.nodeSize,
  });
  if (!transaction) throw new Error("This block cannot be edited here.");
  return transaction;
}

function editBlocks(
  state: EditorState,
  operation: LineOperation,
  selection: Selection,
  range: { parent: Node; first: number; last: number; from: number; to: number } | null,
) {
  const transaction = closeHistory(state.tr).setSelection(selection);
  const direction = operation.direction ?? 1;
  if (!range) {
    if (operation.action !== "insert") return null;
    const paragraph = state.schema.nodes.paragraph;
    const resolved = selection.$from;
    if (!resolved.parent.canReplaceWith(resolved.index(), resolved.index(), paragraph)) return null;
    transaction.insert(selection.from, paragraph.create());
    return transaction.setSelection(TextSelection.near(transaction.doc.resolve(selection.from + 1))).scrollIntoView();
  }
  const { parent, first, last, from, to } = range;
  const content = childFragment(parent, first, last + 1);
  if (operation.action === "delete") {
    transaction.deleteRange(from, to);
    return transaction
      .setSelection(Selection.near(transaction.doc.resolve(Math.min(from, transaction.doc.content.size))))
      .scrollIntoView();
  }
  if (operation.action === "insert") {
    const original = parent.child(direction < 0 ? first : last);
    const next =
      original.type.name === "list_item"
        ? original.type.createAndFill({
            ...original.attrs,
            ...(original.attrs.checked == null ? {} : { checked: false }),
          })
        : state.schema.nodes.paragraph.create();
    const at = direction < 0 ? from : to;
    const index = direction < 0 ? first : last + 1;
    if (!next || !parent.canReplace(index, index, Fragment.from(next))) return null;
    transaction.insert(at, next);
    return transaction.setSelection(TextSelection.near(transaction.doc.resolve(at + 1))).scrollIntoView();
  }
  if (operation.action === "copy") {
    const index = direction < 0 ? first : last + 1;
    if (!parent.canReplace(index, index, content)) return null;
    transaction.insert(direction < 0 ? from : to, content);
    return transaction
      .setSelection(movedSelection(selection, transaction.doc, direction < 0 ? 0 : content.size))
      .scrollIntoView();
  }
  if (operation.action === "move") {
    const index = direction < 0 ? first - 1 : last + 1;
    if (index < 0 || index >= parent.childCount) return null;
    const sibling = parent.child(index);
    const before = direction < 0;
    const replacement = before ? content.append(Fragment.from(sibling)) : Fragment.from(sibling).append(content);
    if (!parent.canReplace(before ? index : first, before ? last + 1 : index + 1, replacement)) return null;
    transaction.replaceWith(before ? from - sibling.nodeSize : from, before ? to : to + sibling.nodeSize, replacement);
    return transaction
      .setSelection(movedSelection(selection, transaction.doc, before ? -sibling.nodeSize : sibling.nodeSize))
      .scrollIntoView();
  }
  return null;
}

export function lineKeymap({
  active_fn,
  editable_fn,
  onNotice,
}: {
  active_fn: () => boolean;
  editable_fn: () => boolean;
  onNotice?: InlineEditorOptions["onNotice"];
}) {
  return $prose(
    () =>
      new Plugin({
        props: {
          handleKeyDown(view, event) {
            const operation = lineShortcut(event);
            if (!operation || !active_fn() || view.composing) return false;
            event.preventDefault();
            if (!editable_fn()) return true;
            try {
              syncViewSelection(view);
              const transaction = richLineTransaction(view.state, operation);
              if (transaction) view.dispatch(transaction);
            } catch (error) {
              onNotice?.(`Could not edit line: ${errorMessage(error)}`, "error");
            }
            return true;
          },
        },
      }),
  );
}
