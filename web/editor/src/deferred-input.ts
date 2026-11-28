import { TextSelection } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";

// While a trusted input event is being handled, Chrome reports every caret change to its browser process
// synchronously, and that report walks the whole editable document: about 16 ms per key in a 1 MB note.
// The same edit made in the next task costs nothing. Plain typing, Enter, Backspace and Delete are
// therefore applied right after their key event instead of inside it. Composition keeps the native path.
const queue: (() => void)[] = [];
const channel = new MessageChannel();
const watched = new WeakSet<HTMLElement>();
let replaying = false;

function flush() {
  for (let action = queue.shift(); action; action = queue.shift()) action();
}
channel.port1.onmessage = flush;
export { flush as flushDeferredInput };

function later(view: EditorView, action: () => void) {
  if (!watched.has(view.dom)) {
    watched.add(view.dom);
    // Anything that arrives before the queued edit ran must still see it applied, in order.
    for (const type of ["keydown", "keypress", "compositionstart", "mousedown", "paste", "cut", "drop", "blur"])
      view.dom.addEventListener(type, flush, true);
    view.dom.addEventListener(
      "beforeinput",
      (event) => {
        if (!queue.length) return;
        flush();
        // The browser chose where to put this text before the queued edit redrew the line, so its own
        // insertion would now land in the wrong place. Insert it through the editor instead.
        if (event.inputType !== "insertText" || !event.data || event.isComposing || view.composing) return;
        event.preventDefault();
        insertTyped(view, event.data);
      },
      true,
    );
  }
  queue.push(() => {
    if (!view.isDestroyed) action();
  });
  channel.port2.postMessage(0);
}

function insertTyped(view: EditorView, text: string) {
  const { from, to } = view.state.selection;
  // Replacing the selection, rather than a range, also moves the caret behind the new text when the
  // selection was a gap or a node.
  const insert = () => view.state.tr.insertText(text);
  if (!view.someProp("handleTextInput", (handle) => handle(view, from, to, text, insert)))
    view.dispatch(insert().scrollIntoView());
}

const plainKey = (event: KeyboardEvent) =>
  event.isTrusted && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing;

/** Insert an ordinary typed character through the editor, after the key event has finished. */
export function handlePlainKeyPress(view: EditorView, event: KeyboardEvent) {
  if (!plainKey(event) || !event.charCode || view.composing) return false;
  const text = String.fromCharCode(event.charCode);
  if (/[\r\n]/.test(text)) return false;
  later(view, () => insertTyped(view, text));
  return true;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Remove the single character beside a caret, as the browser would have. */
function deleteBesideCaret(view: EditorView, backward: boolean) {
  const selection = view.state.selection;
  if (!(selection instanceof TextSelection) || !selection.empty) return;
  const node = backward ? selection.$from.nodeBefore : selection.$from.nodeAfter;
  if (!node) return;
  let size = node.nodeSize;
  if (node.isText && node.text) {
    size = segmenter.segment(node.text).containing(backward ? node.text.length - 1 : 0)?.segment.length ?? 1;
  }
  const { from } = selection;
  view.dispatch(view.state.tr.delete(backward ? from - size : from, backward ? from : from + size).scrollIntoView());
}

/** Run Enter, Backspace and Delete through the editor's own key handlers after the key event. */
export function handleDeferredKey(view: EditorView, event: KeyboardEvent) {
  if (replaying || !plainKey(event) || view.composing) return false;
  if (event.key !== "Enter" && event.key !== "Backspace" && event.key !== "Delete") return false;
  later(view, () => {
    replaying = true;
    try {
      const handled = view.someProp("handleKeyDown", (handle) => handle(view, event));
      if (!handled && event.key !== "Enter") deleteBesideCaret(view, event.key === "Backspace");
    } finally {
      replaying = false;
    }
  });
  return true;
}
