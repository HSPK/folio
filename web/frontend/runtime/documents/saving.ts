import { decodedDocument } from "../../api/contracts";
import { MAX_MARKDOWN_BYTES, markdownByteLength, type DocumentPayload, type SaveCheckpoint } from "@folio/model";
import { createDocumentSaver, type SaveProblem } from "../../services/document-saving";
import { createDocumentTransitions, type LeavePolicy } from "../../services/document-transitions";
import { documentSession, type SaveAcceptance } from "../../state/document";
import { clearTimer, requireValue } from "../../types/elements";
import { errorContext } from "../../types/errors";
import { connectionFailure, refreshControls } from "../accounts/authentication";
import { collaborationState, saveCollaboration } from "../collaboration/collaboration";
import { api } from "../core/api";
import { appState, dirty, rootChanged } from "../core/bootstrap";
import { documentNotice, notice, previewStatus } from "../core/dom";
import { applicationSignal, listen, onApplicationDispose } from "../lifecycle";
import { updateFileTitle } from "../navigation/library";
import { settingsState } from "../preferences/settings";
import { projectWritable } from "../projects/permissions";
import { finishLocalDraft } from "./drafts";
import { confirmDocumentLeave } from "./leave";
import { loadInlineEditor } from "./live";
import { invalidatePreview, renderPreview } from "./preview";

export const SAVE_TIMEOUT_MS = 15000;
let transitions: ReturnType<typeof createDocumentTransitions> | null = null;
let saver: ReturnType<typeof createDocumentSaver> | null = null;
let autoSaveTimer: number | null = null;

export function initializeDocumentsSaving(): void {
  const owner = applicationSignal();
  autoSaveTimer = null;
  const persistence = createDocumentSaver({
    signal: owner,
    session: documentSession,
    text: () => appState.ui.editor.value,
    read: (id) =>
      api(`/api/document?id=${encodeURIComponent(id)}&render=source`, {
        decode: decodedDocument,
        timeoutMs: 5000,
      }),
    write: (snapshot) =>
      api("/api/document", {
        decode: decodedDocument,
        method: "PUT",
        body: { id: snapshot.id, content: snapshot.content, version: snapshot.version },
        timeoutMs: SAVE_TIMEOUT_MS,
      }),
    classify(cause) {
      const error = errorContext(cause);
      return {
        error,
        conflict: error.status === 409,
        uncertain:
          error.status === 408 ||
          error.status === 200 ||
          Boolean(error.network) ||
          error.status >= 500 ||
          !error.status,
      };
    },
    accepted: projectSavedDocument,
    changed: refreshControls,
    problem: projectSaveProblem,
    settled(checkpoint, completed, requested) {
      if (checkpoint.id !== documentSession.id || !documentSession.current || !dirty() || documentSession.conflict)
        return;
      if (requested && appState.connectionState === "ready") void saveDocument();
      else if (completed) scheduleAutoSave();
    },
  });
  saver = persistence;
  const flow = createDocumentTransitions({
    signal: owner,
    read: () => ({
      id: documentSession.id,
      revision: documentSession.revision,
      path: documentSession.current?.path ?? null,
      dirty: dirty(),
      busy: documentSaveBusy(),
      pending: Boolean(documentSession.saving),
      conflict: documentSession.conflict,
    }),
    inFlight: () => documentSession.saving?.completion ?? collaborationState.collaboration?.saveCompletion ?? null,
    save: () => saveDocument(),
    confirm: (request) => confirmDocumentLeave(request, owner),
    timeoutMs: SAVE_TIMEOUT_MS,
    cancelAutoSave,
    resumeAutoSave: () => scheduleAutoSave(),
    onEditingCancelled: () => documentNotice("Navigation canceled"),
    onBlocked: (reason) =>
      documentNotice(reason === "busy" ? "Save in progress" : "Note changed while confirming", "warning"),
  });
  transitions = flow;
  listen(appState.ui.editor, "input", cancelLeaveForEditing);
  onApplicationDispose(() => {
    flow.cancel();
    if (transitions === flow) transitions = null;
    if (saver === persistence) saver = null;
    cancelAutoSave();
  });
}

export function rememberUnconfirmedSave(checkpoint: SaveCheckpoint): void {
  requireValue(saver, "Document persistence").rememberUnconfirmed(checkpoint);
}
export function notifyDocumentSave(): void {
  transitions?.notifySaved();
}
export function cancelLeaveForEditing(): void {
  if (!collaborationState.collaboration?.applying) transitions?.edited();
}
export function documentSaveBusy() {
  return Boolean(
    documentSession.saving ||
    collaborationState.collaboration?.saving ||
    collaborationState.collaboration?.pending.size,
  );
}
export async function prepareDocumentLeave(action: string, policy: LeavePolicy = "save", signal?: AbortSignal) {
  try {
    return await requireValue(transitions, "Document transition coordinator").request(action, policy, signal);
  } catch (cause) {
    const error = errorContext(cause);
    documentNotice(`Navigation failed: ${error.message}`, "error");
    return false;
  }
}
export const saveBeforeLeaving = (action: string, signal?: AbortSignal) => prepareDocumentLeave(action, "save", signal);
export function cancelDocumentTransition() {
  transitions?.cancel();
}
export function cancelAutoSave(): void {
  clearTimer(autoSaveTimer);
  autoSaveTimer = null;
}
export function scheduleAutoSave(delay = settingsState.webPreferences.autoSaveDelayMs): void {
  cancelAutoSave();
  if (!documentSession.current || documentSession.conflict || rootChanged() || appState.connectionState !== "ready")
    return;
  autoSaveTimer = window.setTimeout(() => {
    autoSaveTimer = null;
    if (
      !documentSession.current ||
      documentSession.loading ||
      documentSession.saving ||
      appState.creating ||
      appState.movingEntry ||
      documentSession.conflict ||
      rootChanged() ||
      appState.connectionState !== "ready" ||
      !dirty()
    )
      return;
    void saveDocument(true);
  }, delay);
}

function projectSavedDocument(checkpoint: SaveCheckpoint, payload: DocumentPayload, result: SaveAcceptance): void {
  updateFileTitle(checkpoint.snapshot.path, payload.title ?? null);
  if (appState.ui.editor.value !== result.text) {
    appState.ui.editor.value = result.text;
    loadInlineEditor();
  }
  documentNotice(payload.warning ?? "", payload.warning ? "warning" : "");
  finishLocalDraft();
  if (!result.dirty) {
    invalidatePreview();
    renderPreview(payload.html);
    previewStatus("Up to date");
  }
}

function projectSaveProblem(problem: SaveProblem): void {
  const error = errorContext(problem.error);
  if (isConnectionLoss(error)) {
    connectionFailure(error);
    return;
  }
  if (problem.kind === "conflict") {
    notice(appState.ui.conflictMessage, problem.error.message, "warning");
    documentNotice("");
  } else if (problem.kind === "verification") {
    documentNotice(`Save check failed: ${problem.error.message}`, "error");
  } else if (problem.kind === "too-large") {
    documentNotice(problem.error.message, "error");
  } else {
    documentNotice(`Save failed: ${problem.error.message}`, "error");
    connectionFailure(errorContext(problem.error));
  }
}

export async function saveDocument(automatic = false) {
  if (!projectWritable()) {
    if (!automatic) documentNotice("Read-only", "warning");
    return;
  }
  cancelAutoSave();
  if (collaborationState.collaboration) return saveCollaboration();
  if (documentSession.saving) return requireValue(saver, "Document persistence").save({ queue: !automatic });
  if (!documentSession.current || appState.creating || appState.movingEntry) return;
  if (documentSession.loading) {
    if (!automatic) documentNotice("Note still opening");
    return;
  }
  if (documentSession.conflict) {
    if (!automatic) documentNotice("Resolve disk conflict first", "warning");
    return;
  }
  if (rootChanged() || appState.connectionState !== "ready") {
    if (!automatic && rootChanged()) documentNotice("Notes folder changed", "warning");
    return;
  }
  if (!dirty()) return true;
  const snapshot = documentSession.checkpoint(appState.ui.editor.value);
  if (markdownByteLength(snapshot.snapshot.content) > MAX_MARKDOWN_BYTES) {
    refreshControls();
    if (!automatic) documentNotice("Over 4 MiB, not saved", "error");
    return;
  }
  return requireValue(saver, "Document persistence").save({ queue: !automatic });
}
import { isConnectionLoss } from "../core/recovery";
