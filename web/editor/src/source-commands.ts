import { EditorSelection, EditorState } from "@codemirror/state";
import { keymap, type Command } from "@codemirror/view";
import { defaultKeymap, historyKeymap, indentWithTab, isolateHistory, redo, selectLine } from "@codemirror/commands";

const insertLineAbove: Command = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  dispatch(
    state.update(
      state.changeByRange((range) => {
        const line = state.doc.lineAt(range.from);
        const indent = line.text.match(/^[ \t]*/)?.[0] ?? "";
        return {
          changes: { from: line.from, insert: indent + state.lineBreak },
          range: EditorSelection.cursor(line.from + indent.length),
        };
      }),
      { scrollIntoView: true, userEvent: "input", annotations: isolateHistory.of("full") },
    ),
  );
  return true;
};

export const sourceCommands = [
  EditorState.transactionExtender.of((transaction) =>
    ["delete.line", "move.line", "input.copyline"].some((event) => transaction.isUserEvent(event))
      ? { annotations: isolateHistory.of("full") }
      : null,
  ),
  keymap.of([
    { key: "Mod-Shift-Enter", run: insertLineAbove, preventDefault: true },
    { key: "Mod-l", run: selectLine, preventDefault: true },
    { key: "Mod-Shift-z", run: redo, preventDefault: true },
    ...defaultKeymap,
    ...historyKeymap,
    indentWithTab,
  ]),
];
