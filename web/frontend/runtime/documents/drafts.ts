import { projectModel } from "../../state/projects";
import { authenticationSession } from "../../state/authentication";
import { documentSession } from "../../state/document";
import { decodedDocument } from "../../api/contracts";
import { isAbortError } from "../../api/error";
import { mergeSharedUpdates, createButton } from "@folio/editor-runtime";
import type { DocumentSessionId, DraftIdentity, DraftSnapshot, LocalDraft } from "@folio/model";
import { createDraftRecovery } from "../../services/draft-recovery";
import { createDraftRepository, createDraftWriteQueue, type DraftRepository } from "../../services/draft-repository";
import { draftNonce } from "../../storage/draft-crypto";
import { createIndexedDbDraftStore } from "../../storage/draft-indexeddb";
import { element, clearTimer, requireValue } from "../../types/elements";
import { errorContext } from "../../types/errors";
import { closeMenus, refreshControls } from "../accounts/authentication";
import { collaborationLocked, collaboration } from "../collaboration/collaboration";
import { documentParticipation } from "../collaboration/participation";
import { collaborationNotice, collaborativeSelection } from "../collaboration/presence";
import { api } from "../core/api";
import { appState, dirty, rootChanged } from "../core/bootstrap";
import { documentNotice, notice } from "../core/dom";
import { confirmAction, showDialog } from "../dialogs/dialogs";
import { applicationLifetime, applicationSignal, listen, onApplicationDispose } from "../lifecycle";
import { buttonFeedback } from "../../../shared/feedback";

import { projectWritable } from "../projects/permissions";
import { publicState } from "../sharing/public";
import { loadInlineEditor } from "./live";
import { resourceState } from "./resources";
import { cancelAutoSave, saveDocument, scheduleAutoSave } from "./saving";

const durableWrites = createDraftWriteQueue();
let repository: DraftRepository | null = null;
let recovery: ReturnType<typeof createDraftRecovery> | null = null;
let lifetime: AbortSignal | null = null;
let draftTimer: number | null = null;
let draftDeadline = 0;
let touched: DocumentSessionId | null = null;
let selected: LocalDraft | null = null;
let tab = "";
let applying = false;

export function initializeDocumentsDrafts(): void {
  const owner = applicationSignal();
  lifetime = owner;
  const storageNotice = (message: string) => {
    if (!owner.aborted) documentNotice(message, "warning");
  };
  const owned = createDraftRepository(
    createIndexedDbDraftStore({
      onBlocked: () => storageNotice("Recovery storage blocked by another tab"),
      onVersionChange: () => storageNotice("Recovery storage changed, reload Folio"),
    }),
    durableWrites,
  );
  repository = owned;
  draftTimer = null;
  touched = null;
  selected = null;
  applying = false;
  tab = draftNonce();
  try {
    tab = sessionStorage.getItem("folio.draft.tab") ?? tab;
    sessionStorage.setItem("folio.draft.tab", tab);
  } catch (cause) {
    console.warn("Draft tab identity cannot be retained.", errorContext(cause));
  }
  const workflow = createDraftRecovery({
    signal: owner,
    scope: () => authenticationSession.scope,
    session: documentSession,
    project: draftProject,
    shared: () => {
      const current = collaboration;
      return current?.initialized && !current.closed ? current : null;
    },
    canWrite: () =>
      projectWritable() &&
      appState.connectionState === "ready" &&
      !rootChanged() &&
      !appState.creating &&
      !appState.movingEntry &&
      !collaborationLocked(),
    confirm: (_record, signal) =>
      confirmAction("Apply this draft? It may replace newer text", {
        label: "Apply draft",
        signal,
      }).then(Boolean),
    read: (id, signal) =>
      api(`/api/document?id=${encodeURIComponent(id)}&render=source`, {
        decode: decodedDocument,
        signal,
        timeoutMs: 15000,
      }),
    applySource(text) {
      if (!documentSession.conflict) notice(element("conflict-message"), "");
      refreshControls();
      appState.editor.applyEdit(text);
      loadInlineEditor();
    },
    save: () => saveDocument(),
    persistShared: persistCurrentDraft,
    remove: (record) => currentDraftOwner().remove(record.key, record.generation),
    cancelAutoSave,
    resumeAutoSave: () => scheduleAutoSave(),
  });
  recovery = workflow;
  onApplicationDispose(() => {
    clearTimer(draftTimer);
    workflow.cancel();
    if (repository === owned) {
      repository = null;
      recovery = null;
      lifetime = null;
      selected = null;
      draftTimer = null;
    }
    void owned
      .close()
      .catch((error) => console.warn("Accepted local recovery writes could not finish during disposal.", error));
  });
  const dialog = element("draft-recovery-dialog");
  listen(element("draft-recovery-close"), "click", () => dialog.close());
  listen(dialog, "close", () => workflow.cancel());
  listen(element("draft-recovery-copy"), "click", async () => {
    const record = requireValue(selected, "Recovery copy");
    try {
      await copyPlainText(record.source);
      if (!owner.aborted && selected === record)
        buttonFeedback(element("draft-recovery-copy"), "Copied", applicationLifetime());
    } catch (cause) {
      if (!owner.aborted && selected === record)
        notice(element("draft-recovery-error"), errorContext(cause).message, "error");
    }
  });
  listen(element("draft-recovery-discard"), "click", async () => {
    const record = requireValue(selected, "Recovery copy");
    const scope = authenticationSession.scope;
    try {
      const writer = currentDraftOwner();
      const signal = AbortSignal.any([owner, scope.signal]);
      if (
        !(await confirmAction("Permanently discard this local recovery copy?", {
          label: "Discard copy",
          signal,
          tone: "destructive",
        }))
      )
        return;
      await writer.remove(record.key, record.generation);
      if (!owner.aborted && authenticationSession.isCurrent(scope) && selected === record) dialog.close();
    } catch (cause) {
      if (!owner.aborted && authenticationSession.isCurrent(scope) && selected === record)
        notice(element("draft-recovery-error"), errorContext(cause).message, "error");
    }
  });
  listen(element("draft-recovery-apply"), "click", async () => {
    if (applying) return;
    const record = requireValue(selected, "Recovery copy");
    applying = true;
    element("draft-recovery-apply").disabled = true;
    notice(element("draft-recovery-error"), "");
    try {
      const result = await workflow.apply(record);
      if (owner.aborted || selected !== record) return;
      if (result === "applied") dialog.close();
      else if (
        result === "canceled" &&
        (documentSession.current?.id !== record.document || draftProject() !== record.project)
      )
        dialog.close();
      else if (result === "unsaved") notice(element("draft-recovery-error"), "Not saved, recovery copy kept", "error");
    } catch (cause) {
      if (!owner.aborted && selected === record)
        notice(element("draft-recovery-error"), errorContext(cause).message, "error");
    } finally {
      if (!owner.aborted) {
        applying = false;
        if (selected === record) updateRecoveryControls(record);
      }
    }
  });
  listen(element("drafts-open"), "click", async () => {
    closeMenus();
    const scope = authenticationSession.scope;
    try {
      const records = await currentDraftOwner().list();
      if (owner.aborted || !authenticationSession.isCurrent(scope)) return;
      element("drafts-list").replaceChildren(
        ...records.map((record) => {
          const button = createButton({ label: `${record.path} · ${new Date(record.updated).toLocaleString()}` });
          button.addEventListener("click", () => {
            if (owner.aborted || !authenticationSession.isCurrent(scope)) return;
            element("drafts-dialog").close();
            showDraftRecovery(record);
          });

          return button;
        }),
      );
      notice(element("drafts-message"), records.length ? "" : "No local drafts");
      showDialog(element("drafts-dialog"));
    } catch (cause) {
      if (!owner.aborted && authenticationSession.isCurrent(scope))
        documentNotice(`Recovery unavailable: ${errorContext(cause).message}`, "error");
    }
  });
  listen(element("drafts-close"), "click", () => element("drafts-dialog").close());
  listen(window, "pagehide", () => {
    void persistCurrentDraft().catch(console.error);
  });
  listen(document, "visibilitychange", () => {
    if (document.visibilityState === "hidden") void persistCurrentDraft().catch(console.error);
  });
}

function localRecoveryAvailable() {
  return Boolean(crypto.subtle);
}

function currentDraftIdentity(): DraftIdentity {
  const secret =
    authenticationSession.mode === "users"
      ? authenticationSession.user?.draftKey
      : publicState.publicView
        ? publicState.recoveryKey
        : appState.token;
  const scope =
    authenticationSession.mode === "users"
      ? `${authenticationSession.user?.scope}:${authenticationSession.user?.id}`
      : publicState.publicView
        ? "public-link"
        : appState.currentRoot;
  if (typeof secret !== "string" || !scope) throw new Error("Recovery key unavailable");
  return { scope, secret };
}
function currentDraftOwner() {
  return requireValue(repository, "Local recovery repository").owner(currentDraftIdentity());
}

function encodeDraftUpdates(updates: Uint8Array[]) {
  if (!updates.length) return "";
  const bytes = mergeSharedUpdates(updates);
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32768)
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
  return btoa(parts.join(""));
}
function decodeDraftUpdates(value: string) {
  return value ? Uint8Array.from(atob(value), (character) => character.charCodeAt(0)) : null;
}
function draftProject() {
  return projectModel.active?.id ?? (publicState.publicView ? "public" : appState.currentRoot);
}
export function captureDraft(): DraftSnapshot | null {
  if (!documentSession.current || !documentSession.resourceId) return null;
  const shared = collaboration?.id === documentSession.id ? collaboration : null;
  if (touched !== documentSession.id && !shared?.localModified && !shared?.recoveryRecord) return null;
  return {
    keep: dirty() || Boolean(shared?.localUpdates.size || shared?.pending.size || shared?.unmerged),
    project: draftProject(),
    document: documentSession.current.id,
    path: documentSession.current.path,
    source: appState.editor.value,
    version: documentSession.current.version,
    room: shared?.room ?? null,
    updates: encodeDraftUpdates(shared ? [...shared.localUpdates.values()] : []),
    unmerged: Boolean(shared?.unmerged),
    selection: collaborativeSelection(),
    tab,
  };
}
export async function discardLocalDraft(snapshot: DraftSnapshot | null): Promise<void> {
  if (!snapshot || !localRecoveryAvailable()) return;
  clearTimer(draftTimer);
  draftTimer = null;
  await currentDraftOwner().discard(snapshot);
}

async function persistAccepted(retire: LocalDraft | null = null): Promise<void> {
  const owner = lifetime;
  clearTimer(draftTimer);
  draftTimer = null;
  try {
    const snapshot = captureDraft();
    if (!snapshot) return;
    if (!localRecoveryAvailable()) {
      if (snapshot.keep) throw new Error("Recovery needs HTTPS or localhost");
      return;
    }
    await currentDraftOwner().persist(snapshot, retire);
  } catch (cause) {
    const error = errorContext(cause);
    if (owner && !owner.aborted) documentNotice(`Recovery save failed: ${error.message}`, "warning");
    else console.warn("Local recovery could not finish after its view was disposed.", error);
    throw error;
  }
}
export const persistCurrentDraft = () => persistAccepted();

export function queueDraftPersistence(local = false): void {
  if (local) touched = documentSession.id;
  if (!localRecoveryAvailable()) return;
  // A snapshot re-reads the whole note, so it waits for a pause in typing, but never longer than two seconds.
  const now = performance.now();
  if (draftTimer === null) draftDeadline = now + 2000;
  else clearTimer(draftTimer);
  draftTimer = window.setTimeout(
    () => {
      void persistCurrentDraft().catch(console.error);
    },
    Math.max(0, Math.min(350, draftDeadline - now)),
  );
}
export function finishLocalDraft(): void {
  if (
    !documentSession.current ||
    dirty() ||
    collaboration?.localUpdates.size ||
    collaboration?.pending.size ||
    collaboration?.unmerged
  )
    return;
  if (collaboration && !collaboration.initialized) return;
  const pending = persistAccepted(collaboration?.recoveryRecord ?? null);
  touched = null;
  if (collaboration) {
    collaboration.localModified = false;
    collaboration.recoveryRecord = null;
  }
  void pending.catch(console.error);
}
export async function recoverDocumentDraft(): Promise<void> {
  if (!documentSession.current || !localRecoveryAvailable()) return;
  const id = documentSession.id;
  const owner = lifetime;
  const scope = authenticationSession.scope;
  const current = () => owner && !owner.aborted && authenticationSession.isCurrent(scope) && id === documentSession.id;
  try {
    const reader = currentDraftOwner();
    const record = await reader.forDocument(draftProject(), documentSession.current.id);
    if (!record || !current()) return;
    if (record.source === appState.editor.value && !record.updates) {
      if (!dirty()) await reader.remove(record.key, record.generation);
      return;
    }
    if (
      !collaboration &&
      documentParticipation &&
      resourceState.documentPermissions?.collaborative &&
      record.room &&
      !record.unmerged
    ) {
      documentParticipation.recoveryRecord = record;
      collaborationNotice("Local draft kept");
      return;
    }
    if (collaboration) {
      const shared = collaboration;
      if (!shared.initialized && record.room && !record.unmerged) {
        const update = decodeDraftUpdates(record.updates);
        if (update) {
          shared.shared.apply(update);
          shared.localUpdates.set(++shared.localSequence, update);
          shared.localModified = true;
        }
        shared.room = record.room;
        shared.recoveryRecord = record;
        return;
      }
    }
    showDraftRecovery(record);
  } catch (cause) {
    if (current() && !isAbortError(cause))
      documentNotice(`Recovery read failed: ${errorContext(cause).message}`, "warning");
  }
}

function updateRecoveryControls(record: LocalDraft) {
  element("draft-recovery-apply").disabled =
    applying ||
    !documentSession.current ||
    documentSession.current.id !== record.document ||
    draftProject() !== record.project ||
    !projectWritable();
}
export function showDraftRecovery(record: LocalDraft): void {
  recovery?.cancel();
  selected = record;
  element("draft-recovery-info").textContent = `${record.path} · ${new Date(record.updated).toLocaleString()}`;
  element("draft-recovery-source").value = record.source.slice(0, 200000);
  updateRecoveryControls(record);
  notice(element("draft-recovery-error"), record.source.length > 200000 ? "Preview truncated" : "");
  showDialog(element("draft-recovery-dialog"), { restoreParent: true });
}
import { copyPlainText } from "../../../shared/clipboard";
