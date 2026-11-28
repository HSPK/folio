import { decodedBoolean, decodedDocument, decodedObject, decodedString } from "../../api/contracts";
import { authenticationSession } from "../../state/authentication";
import { documentSession } from "../../state/document";
import { projectModel } from "../../state/projects";
import { shell } from "../../state/shell";
import { errorContext } from "../../types/errors";
import { refreshControls, connectionFailure } from "../accounts/authentication";
import { collaboration } from "../collaboration/collaboration";
import { documentParticipation } from "../collaboration/participation";
import { api } from "../core/api";
import { appState, dirty, rootChanged } from "../core/bootstrap";
import { documentNotice } from "../core/dom";
import { isConnectionLoss } from "../core/recovery";
import { applicationSignal, listen, onApplicationDispose } from "../lifecycle";
import { updateFileTitle } from "../navigation/library";
import { scheduleOutlineRefresh } from "../navigation/outline";
import { editorComposing, hasPendingImages } from "./images";
import { loadInlineEditor } from "./live";
import { schedulePreview } from "./preview";
import { acceptDocumentPermissions } from "./resources";

function available() {
  return (
    document.visibilityState === "visible" &&
    appState.connectionState === "ready" &&
    !appState.connectionController &&
    !rootChanged() &&
    !documentSession.loading &&
    !documentSession.saving &&
    !documentSession.conflict &&
    !appState.movingEntry &&
    !appState.creating &&
    !collaboration &&
    !documentParticipation?.preparing &&
    !documentParticipation?.ready
  );
}

function deferInput() {
  return (
    editorComposing() ||
    hasPendingImages() ||
    document.activeElement?.closest(".folio-metadata") ||
    document.querySelector("dialog[open]")
  );
}

function diskEdit(before: string, after: string) {
  let from = 0,
    oldEnd = before.length,
    newEnd = after.length;
  while (from < oldEnd && from < newEnd && before[from] === after[from]) from++;
  while (oldEnd > from && newEnd > from && before[oldEnd - 1] === after[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  return {
    change: { from, to: oldEnd, insert: after.slice(from, newEnd) },
    map: (offset: number) =>
      offset < from ? offset : offset >= oldEnd ? offset + newEnd - oldEnd : Math.min(offset, newEnd),
  };
}

export function initializeDiskSync(): void {
  const owner = applicationSignal();
  let seen: { session: symbol; stamp: string; version: string } | null = null;
  let request: AbortController | null = null;
  let session = documentSession.id;
  async function check() {
    const base = documentSession.current;
    const id = documentSession.resourceId;
    if (request || !base || !id || !available() || dirty() || deferInput()) return;
    const opened = documentSession.id;
    const revision = documentSession.revision;
    const scope = authenticationSession.scope;
    const project = projectModel.selection;
    const controller = new AbortController();
    request = controller;
    const signal = AbortSignal.any([owner, scope.signal, controller.signal]);
    const current = () =>
      !signal.aborted &&
      available() &&
      project === projectModel.selection &&
      opened === documentSession.id &&
      base === documentSession.current &&
      revision === documentSession.revision;
    const url = `/api/document?id=${encodeURIComponent(id)}&render=`;
    try {
      const knownStamp = seen?.session === opened && seen.version === base.version ? seen.stamp : "";
      const { stamp, changed } = await api(
        url + "stamp&" + new URLSearchParams({ version: base.version, stamp: knownStamp }),
        {
          signal,
          timeoutMs: 5000,
          decode: (value) => {
            const check = decodedObject(value, "document stamp");
            return {
              stamp: decodedString(check.stamp, "document stamp"),
              changed: decodedBoolean(check.changed, "document change"),
            };
          },
        },
      );
      if (!current()) return;
      if (!changed) {
        seen = { session: opened, stamp, version: base.version };
        return;
      }
      // Probe first: if another writer acts between the two reads, the next probe still notices.
      const disk = await api(url + "source", { signal, decode: decodedDocument, timeoutMs: 15000 });
      if (!current() || disk.id !== id || disk.project !== base.project || disk.path !== base.path) return;
      if (disk.version !== base.version) {
        if (deferInput()) return;
        appState.inlineEditor.flushInput();
        if (!current() || dirty()) return;
        const rich = shell.view === "rich";
        const editor = appState.editor;
        const live = appState.inlineEditor;
        const selection = rich ? live.getSelection() : editor.getSelection();
        const top = rich ? 0 : editor.scrollTop;
        const next = documentSession.acceptRemote(disk, base.root).text;
        const { map, change } = diskEdit(base.text, next);
        if (rich || shell.view === "preview") editor.value = next;
        else editor.applyDiskChange(change, next);
        documentSession.edited();
        if (rich) {
          if (live.replaceSource(next)) {
            if (selection) live.select(map(selection.from), map(selection.to), false, false);
          } else loadInlineEditor();
        } else if (selection) {
          editor.setSelectionRange(map(selection.from), map(selection.to));
          editor.scrollTop = top;
        }
        if (disk.permissions) acceptDocumentPermissions(disk.permissions);
        updateFileTitle(disk.path, disk.title);
        documentNotice(disk.warning ?? "", disk.warning ? "warning" : "");
        scheduleOutlineRefresh();
        schedulePreview(0);
        refreshControls();
      }
      seen = { session: opened, stamp, version: disk.version };
    } catch (cause) {
      const error = errorContext(cause);
      if (current() && isConnectionLoss(error)) connectionFailure(error);
      else if (!signal.aborted && !(cause instanceof Error && cause.name === "ApiError"))
        console.error("Document sync failed", cause);
    } finally {
      if (request === controller) request = null;
    }
  }
  const cancel = () => {
    request?.abort();
    request = null;
  };
  onApplicationDispose(
    documentSession.subscribe(() => {
      if (session === documentSession.id) return;
      session = documentSession.id;
      seen = null;
      cancel();
    }),
  );
  const timer = window.setInterval(() => void check(), 1500);
  listen(window, "focus", () => void check());
  listen(document, "visibilitychange", () => (document.hidden ? cancel() : void check()));
  onApplicationDispose(() => {
    clearInterval(timer);
    cancel();
  });
}
