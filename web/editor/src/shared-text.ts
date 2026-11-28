import * as Y from "yjs";
import { diffChars } from "diff";
import { EditorState, Transaction } from "@codemirror/state";
import { redoDepth, undoDepth } from "@codemirror/commands";
import { historyTransaction, type HistoryCommand } from "./markdown-history.ts";
import type { ChangedRange, TextSelectionRange } from "./types/editor.ts";

export interface RelativeSelection {
  anchor: number[];
  head: number[];
}

export { mergeUpdates as mergeSharedUpdates } from "yjs";

export function createSharedText(onUpdate: (update: Uint8Array) => void) {
  const doc = new Y.Doc();
  const text = doc.getText("markdown");
  const local = {};
  const handoff = {};
  const undo = new Y.UndoManager(text, { trackedOrigins: new Set([local]), captureTimeout: 500 });
  let prior: EditorState | null = null;
  let priorRedos = 0;
  text.observe((event) => {
    if (!prior || event.transaction.origin === handoff) return;
    // Map the solo inverses through the actual CRDT deltas (not a string diff: identical
    // characters can have different owners). Neither peer edits nor room undo enter this stack.
    let offset = 0;
    const changes = [];
    for (const part of event.delta) {
      if (part.retain) offset += part.retain;
      else if (part.delete) {
        changes.push({ from: offset, to: offset + part.delete });
        offset += part.delete;
      } else if (typeof part.insert === "string") changes.push({ from: offset, insert: part.insert });
    }
    prior = prior.update({ changes, annotations: Transaction.addToHistory.of(false) }).state;
    if (event.transaction.origin === local) priorRedos = 0;
  });
  const replayPrior = (kind: HistoryCommand) => {
    const tr = prior && historyTransaction(prior, kind);
    if (!tr) return false;
    prior = tr.state;
    priorRedos += kind === "undo" ? 1 : -1;
    doc.transact(() => {
      tr.changes.iterChanges((fromA, toA, fromB, _toB, insert) => {
        if (toA > fromA) text.delete(fromB, toA - fromA);
        if (insert.length) text.insert(fromB, insert.toString());
      });
    }, handoff);
    return true;
  };
  doc.on("update", (update, origin) => {
    if (origin === local || origin === undo || origin === handoff) onUpdate(update);
  });
  const absolute = (bytes: number[]) => {
    if (!Array.isArray(bytes) || bytes.length > 256) return null;
    const position = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(Uint8Array.from(bytes)),
      doc,
    );
    return position?.type === text ? position.index : null;
  };
  return {
    get value() {
      return text.toString();
    },
    replace(value: string) {
      const previous = text.toString();
      if (previous === value) return;
      let start = 0;
      let a = previous.length;
      let b = value.length;
      while (start < a && start < b && previous.charCodeAt(start) === value.charCodeAt(start)) start++;
      // Y.Text offsets are UTF-16, but its items cannot be split inside a surrogate pair.
      if (start && /[\uD800-\uDBFF]/.test(previous[start - 1])) start--;
      while (a > start && b > start && previous.charCodeAt(a - 1) === value.charCodeAt(b - 1)) {
        a--;
        b--;
      }
      if (a < previous.length && /[\uDC00-\uDFFF]/.test(previous[a])) {
        a++;
        b++;
      }
      const insert = value.slice(start, b);
      const changes = a > start && insert ? diffChars(previous.slice(start, a), insert, { timeout: 200 }) : [];
      if (!changes) throw new Error("Edit too large to merge");
      doc.transact(() => {
        if (!changes.length) {
          if (a > start) text.delete(start, a - start);
          if (insert) text.insert(start, insert);
          return;
        }
        let index = start;
        for (const change of changes) {
          if (change.added) text.insert(index, change.value);
          else if (change.removed) text.delete(index, change.value.length);
          if (!change.removed) index += change.value.length;
        }
      }, local);
    },
    apply(update: Uint8Array) {
      Y.applyUpdate(doc, update, "remote");
    },
    snapshot() {
      return Y.encodeStateAsUpdate(doc);
    },
    changesSince(update: Uint8Array) {
      return Y.encodeStateAsUpdate(doc, Y.encodeStateVectorFromUpdate(update));
    },
    relative(selection: TextSelectionRange | null) {
      if (!selection) return null;
      const position = (index: number) =>
        Array.from(
          Y.encodeRelativePosition(
            Y.createRelativePositionFromTypeIndex(text, Math.max(0, Math.min(text.length, index))),
          ),
        );
      const anchor = position(selection.from);
      return { anchor, head: selection.from === selection.to ? anchor : position(selection.to) };
    },
    resolve(cursor: RelativeSelection | null) {
      if (!cursor) return null;
      const from = absolute(cursor.anchor);
      const to = absolute(cursor.head);
      return from === null || to === null ? null : { from, to };
    },
    adoptSoloHistory(state: EditorState | null) {
      if (!state || (!undoDepth(state) && !redoDepth(state)) || state.doc.toString() !== text.toString()) return;
      // Only the server's untouched, single-insert seed proves which characters the solo
      // offsets referred to. A previously edited room can even have identical visible text.
      const clocks = [...Y.decodeStateVector(Y.encodeStateVector(doc)).values()];
      if (clocks.length > 1 || (clocks[0] ?? 0) !== text.length) return;
      prior = state;
      priorRedos = redoDepth(state);
    },
    undo() {
      undo.stopCapturing();
      if (!undo.undo()) replayPrior("undo");
    },
    isolateHistory() {
      undo.stopCapturing();
    },
    watchRemoteImageEdits(notify: (ranges: ChangedRange[], next: string) => void) {
      const observe = (event: Y.YTextEvent) => {
        if (
          event.transaction.origin !== "remote" &&
          event.transaction.origin !== undo &&
          event.transaction.origin !== handoff
        )
          return;
        const ranges: ChangedRange[] = [];
        let a = 0,
          b = 0;
        for (const change of event.delta) {
          if (change.retain) {
            a += change.retain;
            b += change.retain;
          } else {
            const previous = ranges.at(-1);
            const range = previous?.toA === a && previous.toB === b ? previous : null;
            const fromA = a,
              fromB = b;
            a += change.delete ?? 0;
            b += typeof change.insert === "string" ? change.insert.length : 0;
            if (range) {
              range.toA = a;
              range.toB = b;
            } else ranges.push({ fromA, toA: a, fromB, toB: b });
          }
        }
        notify(ranges, text.toString());
      };
      text.observe(observe);
      return () => text.unobserve(observe);
    },
    redo() {
      undo.stopCapturing();
      if (!priorRedos || !replayPrior("redo")) undo.redo();
    },
    destroy() {
      undo.destroy();
      doc.destroy();
    },
  };
}
