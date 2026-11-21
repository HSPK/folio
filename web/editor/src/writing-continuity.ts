import { Selection, TextSelection } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import { syncViewSelection } from "./cursor-coordinates.ts";

/**
 * Treat the page margins and the space after the last block as part of the
 * document, so pressing there continues writing instead of focusing the scroller.
 */
export function continueWritingFromBlankSpace(view: EditorView, event: MouseEvent, blank: readonly EventTarget[]) {
  if (event.button !== 0 || event.defaultPrevented || !event.target || !blank.includes(event.target)) return;
  const bounds = view.dom.getBoundingClientRect();
  if (event.clientY < bounds.top) return;
  event.preventDefault();
  const { doc, schema } = view.state;
  let transaction = view.state.tr;
  if (event.clientY >= bounds.bottom) {
    const last = doc.lastChild;
    if (last && last.type !== schema.nodes.paragraph) {
      transaction = transaction.insert(doc.content.size, schema.nodes.paragraph.create());
    }
    transaction = transaction.setSelection(Selection.atEnd(transaction.doc));
  } else {
    const before = event.clientX < bounds.left;
    const found = view.posAtCoords({ left: before ? bounds.left + 1 : bounds.right - 1, top: event.clientY });
    if (!found) return;
    transaction = transaction.setSelection(Selection.near(doc.resolve(found.pos), before ? 1 : -1));
  }
  view.dispatch(transaction.scrollIntoView());
  view.focus();
}

/**
 * Leave a code block from the keyboard: Arrow Down on its last line when nothing
 * follows it, or Enter on a second consecutive empty line at its end.
 */
export function handleCodeExitKeyDown(view: EditorView, event: KeyboardEvent) {
  if (event.isComposing || view.composing || !view.editable) return false;
  if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false;
  if (event.key !== "ArrowDown" && event.key !== "Enter") return false;
  // A native caret move can precede the editor's selectionchange; decide from the caret the writer sees.
  const anchor = view.dom.ownerDocument.getSelection()?.anchorNode;
  const element = anchor instanceof Element ? anchor : anchor?.parentElement;
  if (!element?.closest(".folio-code-block")) return false;
  syncViewSelection(view);
  const { selection, schema } = view.state;
  const { $head, empty } = selection;
  const block = $head.parent;
  if (!empty || block.type.name !== "code_block" || !schema.nodes.paragraph) return false;
  const text = block.textContent;
  const offset = $head.parentOffset;
  const after = $head.after();
  const container = $head.node($head.depth - 1);
  const index = $head.index($head.depth - 1);
  if (!container.canReplaceWith(index + 1, index + 1, schema.nodes.paragraph)) return false;
  let transaction = view.state.tr;
  if (event.key === "ArrowDown") {
    if (text.indexOf("\n", offset) !== -1 || index + 1 < container.childCount) return false;
    transaction = transaction.insert(after, schema.nodes.paragraph.create());
    transaction = transaction.setSelection(TextSelection.create(transaction.doc, after + 1));
  } else {
    if (offset !== text.length || !text.endsWith("\n\n")) return false;
    const start = $head.start();
    transaction = transaction.delete(start + text.length - 2, start + text.length);
    const position = transaction.mapping.map(after);
    transaction = transaction.insert(position, schema.nodes.paragraph.create());
    transaction = transaction.setSelection(TextSelection.create(transaction.doc, position + 1));
  }
  view.dispatch(transaction.scrollIntoView());
  event.preventDefault();
  return true;
}
