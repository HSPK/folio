import * as Y from "yjs";
import { diffChars } from "diff";
import type { TextSelectionRange } from "./types/editor.ts";

export interface RelativeSelection {
  anchor: number[];
  head: number[];
}

export function mergeSharedUpdates(updates: Uint8Array[]) {
  return Y.mergeUpdates(updates);
}

export function createSharedText(onUpdate: (update: Uint8Array) => void) {
  const doc = new Y.Doc();
  const text = doc.getText("markdown");
  const local = {};
  const undo = new Y.UndoManager(text, { trackedOrigins: new Set([local]), captureTimeout: 500 });
  doc.on("update", (update, origin) => {
    if (origin === local || origin === undo) onUpdate(update);
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
      const changes = diffChars(previous, value, { timeout: 200 });
      if (!changes) throw new Error("The edit is too large to merge safely. Split it into smaller edits.");
      doc.transact(() => {
        let index = 0;
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
      return { anchor: position(selection.from), head: position(selection.to) };
    },
    resolve(cursor: RelativeSelection | null) {
      if (!cursor) return null;
      const from = absolute(cursor.anchor);
      const to = absolute(cursor.head);
      return from === null || to === null ? null : { from, to };
    },
    undo() {
      undo.stopCapturing();
      undo.undo();
    },
    redo() {
      undo.stopCapturing();
      undo.redo();
    },
    destroy() {
      undo.destroy();
      doc.destroy();
    },
  };
}
