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
    onEditingCancelled: () => documentNotice("Navigation canceled because you continued editing. Your text is kept."),
    onBlocked: (reason) =>
      documentNotice(
        reason === "busy"
          ? "Wait for the current save to finish, then try again."
          : "The note changed while you were confirming. Review the current text before leaving.",
        "warning",
      ),
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
    documentNotice(`Could not prepare to ${action}: ${error.message} Your editor text is kept.`, "error");
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
  if (problem.kind === "conflict") {
    notice(
      appState.ui.conflictMessage,
      `This file changed on disk: ${problem.error.message} Your editor text has been kept and was not saved. ` +
        "Copy your changes before choosing Reload from disk. Folio will not overwrite the external changes.",
      "warning",
    );
    documentNotice("");
  } else if (problem.kind === "verification") {
    documentNotice(`Could not verify the previous save: ${problem.error.message} Your editor text is kept.`, "error");
  } else if (problem.kind === "too-large") {
    documentNotice(problem.error.message, "error");
  } else {
    documentNotice(`Could not save: ${problem.error.message} Your editor text has been kept.`, "error");
    connectionFailure(errorContext(problem.error));
  }
}

export async function saveDocument(automatic = false) {
  if (!projectWritable()) {
    if (!automatic) documentNotice("This page is read-only.", "warning");
    return;
  }
  cancelAutoSave();
  if (collaborationState.collaboration) return saveCollaboration();
  if (documentSession.saving) return requireValue(saver, "Document persistence").save({ queue: !automatic });
  if (!documentSession.current || appState.creating || appState.movingEntry) return;
  if (documentSession.loading) {
    if (!automatic) documentNotice("A note is still opening. Keep typing to cancel that request before saving.");
    return;
  }
  if (documentSession.conflict) {
    if (!automatic)
      documentNotice("Resolve the disk conflict first. Copy your changes before choosing Reload from disk.", "warning");
    return;
  }
  if (rootChanged() || appState.connectionState !== "ready") {
    if (!automatic)
      documentNotice(
        "Saving is unavailable until this tab is connected to the same notes folder. Your editor text has been kept.",
        "error",
      );
    return;
  }
  if (!dirty()) return true;
  const snapshot = documentSession.checkpoint(appState.ui.editor.value);
  if (markdownByteLength(snapshot.snapshot.content) > MAX_MARKDOWN_BYTES) {
    refreshControls();
    if (!automatic) documentNotice("The note exceeds the 4 MiB limit and has not been saved.", "error");
    return;
  }
  return requireValue(saver, "Document persistence").save({ queue: !automatic });
}
