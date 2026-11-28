import { EditorSelection, EditorState, Transaction } from "@codemirror/state";
import { history, historyField, isolateHistory, redo, undo } from "@codemirror/commands";

export type HistoryCommand = "undo" | "redo";
export type LiveEdit = HistoryCommand | "group" | "continue" | "metadata";

// Carry just the document and its immutable history field, not a virtual editor's view plugins.
export function markdownHistory(state: EditorState) {
  return EditorState.create({
    doc: state.doc,
    selection: state.selection,
    extensions: [history(), historyField.init(() => state.field(historyField))],
  });
}

export function historyTransaction(state: EditorState, kind: HistoryCommand) {
  let result: Transaction | undefined;
  (kind === "undo" ? undo : redo)({ state, dispatch: (tr) => (result = tr) });
  return result;
}

export function textChange(before: string, after: string) {
  let from = 0,
    to = before.length,
    end = after.length;
  while (from < to && from < end && before.charCodeAt(from) === after.charCodeAt(from)) from++;
  while (to > from && end > from && before.charCodeAt(to - 1) === after.charCodeAt(end - 1)) {
    to--;
    end--;
  }
  return { from, to, insert: after.slice(from, end) };
}

// Mirror ProseMirror's event boundaries, including its own undo/redo, in source coordinates.
export function liveTransaction(state: EditorState, before: string, after: string, edit: LiveEdit) {
  if (edit === "undo" || edit === "redo") {
    const replay = historyTransaction(state, edit);
    if (replay && replay.newDoc.toString() === after) return replay;
  }
  const change = textChange(before, after);
  return state.update({
    changes: change,
    selection: EditorSelection.cursor(change.from + change.insert.length),
    userEvent: edit === "continue" ? "input.type.compose" : "input.live",
    annotations:
      edit === "metadata"
        ? Transaction.addToHistory.of(false)
        : isolateHistory.of(edit === "continue" ? "after" : "full"),
  });
}
