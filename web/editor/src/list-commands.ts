import { splitListItem, liftListItem } from "@milkdown/prose/schema-list";
import { closeHistory } from "@milkdown/prose/history";
import { Selection, type EditorState, type Transaction } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";

export function outdentTrailingListLine(state: EditorState, dispatch_fn?: (transaction: Transaction) => void) {
  const { empty, $from } = state.selection;
  if (
    !empty ||
    $from.depth < 2 ||
    $from.parent.type.name !== "paragraph" ||
    $from.parentOffset !== $from.parent.content.size ||
    $from.parent.lastChild?.type.name !== "hardbreak"
  )
    return false;
  const item = $from.node(-1);
  if (item.type.name !== "list_item") return false;
  const transaction = closeHistory(state.tr).delete($from.pos - 1, $from.pos);
  const append = (next: Transaction) => {
    for (const step of next.steps) transaction.step(step);
    transaction.setSelection(Selection.fromJSON(transaction.doc, next.selection.toJSON()));
  };
  // Lift the empty visual line, not the item containing the preceding text.
  if (
    !splitListItem(item.type)(state.apply(transaction), append) ||
    !liftListItem(item.type)(state.apply(transaction), append)
  )
    return false;
  dispatch_fn?.(transaction.scrollIntoView());
  return true;
}

export function handleListKeyDown(
  view: Pick<EditorView, "state" | "composing" | "editable" | "dispatch">,
  event: KeyboardEvent,
) {
  const outdent =
    (event.key === "Tab" && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) ||
    (event.key === "[" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey);
  if (!outdent || event.isComposing || view.composing || !view.editable) return false;
  return outdentTrailingListLine(view.state, (transaction) => view.dispatch(transaction));
}
