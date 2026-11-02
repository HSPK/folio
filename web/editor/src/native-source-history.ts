import { EditorSelection, EditorState } from "@codemirror/state";
import type { Transaction } from "@codemirror/state";
import { history, isolateHistory, redo, undo } from "@codemirror/commands";
import { lineShortcut, textLineEdit } from "./line-keymap.ts";
import { textareaCursorRect } from "./cursor-coordinates.ts";
import { errorMessage } from "./errors.ts";
import type { ChangedRange, NoticeKind, SourceChanges } from "./types/editor.ts";

interface PendingInput {
  from: number;
  to: number;
  type: string;
  composing: boolean;
}

interface NativeHistoryOptions {
  textarea: HTMLTextAreaElement;
  active_fn: () => boolean;
  editable_fn: () => boolean;
  emit_fn: (changes: SourceChanges) => void;
  onNotice: (message: string, kind?: NoticeKind) => void;
}

function inputChange(previous: string, next: string, pending: PendingInput | null) {
  if (pending && !pending.composing) {
    let { from, to } = pending;
    const removed = previous.length - next.length;
    if (from === to && pending.type === "deleteContentBackward") from -= removed;
    if (from === to && pending.type === "deleteContentForward") to += removed;
    const length = next.length - previous.length + to - from;
    if (
      [
        "insertText",
        "insertLineBreak",
        "insertParagraph",
        "insertFromPaste",
        "deleteContentBackward",
        "deleteContentForward",
        "deleteByCut",
      ].includes(pending.type) &&
      from >= 0 &&
      to <= previous.length &&
      length >= 0
    ) {
      return { from, to, insert: next.slice(from, from + length) };
    }
  }
  let from = 0;
  const shared = Math.min(previous.length, next.length);
  while (from < shared && previous.charCodeAt(from) === next.charCodeAt(from)) from++;
  let to = previous.length;
  let end = next.length;
  while (to > from && end > from && previous.charCodeAt(to - 1) === next.charCodeAt(end - 1)) {
    to--;
    end--;
  }
  return { from, to, insert: next.slice(from, end) };
}

export function createNativeSourceHistory({
  textarea,
  active_fn,
  editable_fn,
  emit_fn,
  onNotice,
}: NativeHistoryOptions) {
  // Share the virtual editor's history engine without replacing native text rendering.
  let state: EditorState | null = null;
  let text = textarea.value;
  let pending: PendingInput | null = null;
  let emitting = false;
  let compositionOpen = false;
  let frame = 0;
  const selection = () => {
    const backwards = textarea.selectionDirection === "backward";
    return EditorSelection.range(
      backwards ? textarea.selectionEnd : textarea.selectionStart,
      backwards ? textarea.selectionStart : textarea.selectionEnd,
    );
  };
  const prepare = () => {
    state ??= EditorState.create({ doc: text, extensions: [history()] });
    state = state.update({ selection: selection() }).state;
    return state;
  };
  const dispatch = (transaction: Transaction) => {
    state = transaction.state;
    pending = null;
    if (transaction.docChanged) {
      text = state.doc.toString();
      textarea.value = text;
    }
    const range = state.selection.main;
    textarea.setSelectionRange(range.from, range.to, range.anchor > range.head ? "backward" : "forward");
    if (!frame)
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!active_fn() || textarea.ownerDocument.activeElement !== textarea) return;
        const caret = textareaCursorRect(
          textarea,
          textarea.selectionDirection === "backward" ? textarea.selectionStart : textarea.selectionEnd,
        );
        if (!caret) return;
        const bounds = textarea.getBoundingClientRect();
        if (caret.top < bounds.top + 4) textarea.scrollTop += caret.top - bounds.top - 4;
        else if (caret.bottom > bounds.bottom - 4) textarea.scrollTop += caret.bottom - bounds.bottom + 4;
        if (textarea.wrap === "off") {
          if (caret.left < bounds.left + 4) textarea.scrollLeft += caret.left - bounds.left - 4;
          else if (caret.right > bounds.right - 4) textarea.scrollLeft += caret.right - bounds.right + 4;
        }
      });
    if (!transaction.docChanged) return;
    const ranges: ChangedRange[] = [];
    transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => ranges.push({ fromA, toA, fromB, toB }));
    emitting = true;
    try {
      emit_fn({ ranges, beforeLength: transaction.startState.doc.length, afterLength: state.doc.length });
    } finally {
      emitting = false;
    }
  };
  const historyCommand = (kind: "undo" | "redo") => (kind === "undo" ? undo : redo)({ state: prepare(), dispatch });
  const beforeInput = (event: InputEvent) => {
    if (!active_fn() || emitting) return;
    if (["historyUndo", "historyRedo"].includes(event.inputType) && event.cancelable) {
      event.preventDefault();
      if (editable_fn()) historyCommand(event.inputType === "historyUndo" ? "undo" : "redo");
      return;
    }
    if (!editable_fn()) return;
    prepare();
    pending = {
      from: textarea.selectionStart,
      to: textarea.selectionEnd,
      type: event.inputType,
      composing: event.isComposing,
    };
  };
  const input = (event: Event) => {
    if (!active_fn() || emitting) return;
    const next = textarea.value;
    if (!editable_fn()) {
      state = null;
      text = next;
      pending = null;
      return;
    }
    const native = event instanceof InputEvent ? event : null;
    const composing = Boolean(native?.isComposing) || /Composition/.test(native?.inputType ?? "");
    state ??= EditorState.create({ doc: text, extensions: [history()] });
    if (next !== text) {
      const change = inputChange(text, next, pending);
      const userEvent = composing
        ? compositionOpen
          ? "input.type.compose"
          : "input.type.compose.start"
        : /^delete/.test(native?.inputType ?? "")
          ? "delete"
          : native?.inputType === "insertFromPaste"
            ? "input.paste"
            : "input.type";
      state = state.update({
        changes: change,
        selection: selection(),
        userEvent,
        annotations: composing && !compositionOpen ? isolateHistory.of("before") : [],
      }).state;
      text = next;
    }
    compositionOpen = composing;
    pending = null;
  };
  const compositionStart = () => {
    compositionOpen = false;
  };
  const keydown = (event: KeyboardEvent) => {
    if (!active_fn() || event.isComposing || event.defaultPrevented) return;
    const key = event.key.toLowerCase();
    const primary = (event.metaKey || event.ctrlKey) && !event.altKey;
    const kind =
      primary && key === "z"
        ? event.shiftKey
          ? "redo"
          : "undo"
        : primary && !event.shiftKey && key === "y"
          ? "redo"
          : null;
    const operation = lineShortcut(event);
    if (!operation && !kind) return;
    event.preventDefault();
    if (!editable_fn()) return;
    try {
      if (kind) {
        historyCommand(kind);
        return;
      }
      if (!operation) throw new Error("The source line shortcut has no editing action.");
      const current = prepare();
      const range = current.selection.main;
      const edit = textLineEdit(text, { anchor: range.anchor, head: range.head }, operation);
      if (!edit) return;
      dispatch(
        current.update({
          ...(edit.insert === null ? {} : { changes: { from: edit.from, to: edit.to, insert: edit.insert } }),
          selection: EditorSelection.range(edit.anchor, edit.head),
          annotations: isolateHistory.of("full"),
          userEvent: "input.line",
        }),
      );
    } catch (error) {
      onNotice(`Could not edit source line: ${errorMessage(error)}`, "error");
    }
  };
  textarea.addEventListener("beforeinput", beforeInput);
  textarea.addEventListener("input", input);
  textarea.addEventListener("keydown", keydown);
  textarea.addEventListener("compositionstart", compositionStart);
  return {
    replace(next: string) {
      const current = prepare();
      dispatch(
        current.update({
          changes: { from: 0, to: current.doc.length, insert: next },
          selection: EditorSelection.cursor(next.length),
          annotations: isolateHistory.of("full"),
          userEvent: "input.recovery",
        }),
      );
    },
    reset(value: string) {
      cancelAnimationFrame(frame);
      frame = 0;
      state = null;
      text = value;
      pending = null;
      compositionOpen = false;
    },
    destroy() {
      cancelAnimationFrame(frame);
      textarea.removeEventListener("beforeinput", beforeInput);
      textarea.removeEventListener("input", input);
      textarea.removeEventListener("keydown", keydown);
      textarea.removeEventListener("compositionstart", compositionStart);
    },
  };
}
