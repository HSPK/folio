import { projectModel } from "../../state/projects";
import { authenticationSession } from "../../state/authentication";
import { documentSession } from "../../state/document";
import { decodedDocument } from "../../api/contracts";
import { isAbortError } from "../../api/error";
import { mergeSharedUpdates } from "@folio/editor-runtime";
import type { DocumentSessionId, DraftIdentity, DraftSnapshot, LocalDraft } from "@folio/model";
import { createDraftRecovery } from "../../services/draft-recovery";
import { createDraftRepository, createDraftWriteQueue, type DraftRepository } from "../../services/draft-repository";
import { draftNonce } from "../../storage/draft-crypto";
import { createIndexedDbDraftStore } from "../../storage/draft-indexeddb";
import { clearTimer, requireValue } from "../../types/elements";
import { errorContext } from "../../types/errors";
import { closeMenus, refreshControls } from "../accounts/authentication";
import { collaborationLocked, collaborationState } from "../collaboration/collaboration";
import { participationState } from "../collaboration/participation";
import { collaborationNotice, collaborativeSelection } from "../collaboration/presence";
import { api } from "../core/api";
import { appState, dirty, rootChanged } from "../core/bootstrap";
import { documentNotice, notice } from "../core/dom";
import { confirmAction, showDialog } from "../dialogs/dialogs";
import { applicationSignal, listen, onApplicationDispose } from "../lifecycle";

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
      onBlocked: () =>
        storageNotice("Local recovery storage is blocked by another tab. Close old Folio tabs to finish upgrading."),
      onVersionChange: () =>
        storageNotice("Local recovery storage changed in another tab. Reload Folio before editing more notes."),
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
      const current = collaborationState.collaboration;
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
      confirmAction("Apply this draft as a new edit? It may replace newer text.", {
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
      if (!documentSession.conflict) notice(appState.ui.conflictMessage, "");
      refreshControls();
      appState.ui.editor.applyEdit(text);
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
  const dialog = appState.element("draft-recovery-dialog");
  listen(appState.element("draft-recovery-close"), "click", () => dialog.close());
  listen(dialog, "close", () => workflow.cancel());
  listen(appState.element("draft-recovery-copy"), "click", async () => {
    const record = requireValue(selected, "Recovery copy");
    try {
      await navigator.clipboard.writeText(record.source);
    } catch (cause) {
      if (!owner.aborted && selected === record)
        notice(appState.element("draft-recovery-error"), errorContext(cause).message, "error");
    }
  });
  listen(appState.element("draft-recovery-discard"), "click", async () => {
    const record = requireValue(selected, "Recovery copy");
    const scope = authenticationSession.scope;
    try {
      const writer = currentDraftOwner();
      const signal = AbortSignal.any([owner, scope.signal]);
      if (!(await confirmAction("Permanently discard this local recovery copy?", { label: "Discard copy", signal })))
        return;
      await writer.remove(record.key, record.generation);
      if (!owner.aborted && authenticationSession.isCurrent(scope) && selected === record) dialog.close();
    } catch (cause) {
      if (!owner.aborted && authenticationSession.isCurrent(scope) && selected === record)
        notice(appState.element("draft-recovery-error"), errorContext(cause).message, "error");
    }
  });
  listen(appState.element("draft-recovery-apply"), "click", async () => {
    if (applying) return;
    const record = requireValue(selected, "Recovery copy");
    applying = true;
    appState.element("draft-recovery-apply").disabled = true;
    notice(appState.element("draft-recovery-error"), "");
    try {
      const result = await workflow.apply(record);
      if (owner.aborted || selected !== record) return;
      if (result === "applied") dialog.close();
      else if (
        result === "canceled" &&
        (documentSession.current?.id !== record.document || draftProject() !== record.project)
      )
        dialog.close();
      else if (result === "unsaved")
        notice(
          appState.element("draft-recovery-error"),
          "The recovery copy is kept because saving was not confirmed. Resolve the save error, then retry.",
          "error",
        );
    } catch (cause) {
      if (!owner.aborted && selected === record)
        notice(appState.element("draft-recovery-error"), errorContext(cause).message, "error");
    } finally {
      if (!owner.aborted) {
        applying = false;
        if (selected === record) updateRecoveryControls(record);
      }
    }
  });
  listen(appState.element("drafts-open"), "click", async () => {
    closeMenus();
    const scope = authenticationSession.scope;
    try {
      const records = await currentDraftOwner().list();
      if (owner.aborted || !authenticationSession.isCurrent(scope)) return;
      appState.element("drafts-list").replaceChildren(
        ...records.map((record) => {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = `${record.path} · ${new Date(record.updated).toLocaleString()}`;
          button.addEventListener("click", () => {
            if (owner.aborted || !authenticationSession.isCurrent(scope)) return;
            appState.element("drafts-dialog").close();
            showDraftRecovery(record);
          });
          return button;
        }),
      );
      notice(appState.element("drafts-message"), records.length ? "" : "No unsaved local drafts.");
      showDialog(appState.element("drafts-dialog"));
    } catch (cause) {
      if (!owner.aborted && authenticationSession.isCurrent(scope))
        documentNotice(`Local recovery is unavailable: ${errorContext(cause).message}`, "error");
    }
  });
  listen(appState.element("drafts-close"), "click", () => appState.element("drafts-dialog").close());
  listen(window, "pagehide", () => {
    void persistCurrentDraft().catch(console.error);
  });
  listen(document, "visibilitychange", () => {
    if (document.visibilityState === "hidden") void persistCurrentDraft().catch(console.error);
  });
}

export function localRecoveryAvailable() {
  return Boolean(crypto.subtle);
}

function currentDraftIdentity(): DraftIdentity {
  const secret =
    authenticationSession.mode === "users"
      ? authenticationSession.user?.draftKey
      : publicState.publicView
        ? publicState.publicToken
        : appState.token;
  const scope =
    authenticationSession.mode === "users"
      ? `${authenticationSession.user?.scope}:${authenticationSession.user?.id}`
      : publicState.publicView
        ? "public-link"
        : appState.currentRoot;
  if (typeof secret !== "string" || !scope)
    throw new Error("The private recovery key is unavailable. Reconnect before closing unsaved work.");
  return { scope, secret };
}
function currentDraftOwner() {
  return requireValue(repository, "Local recovery repository").owner(currentDraftIdentity());
}

export function encodeDraftUpdates(updates: Uint8Array[]) {
  if (!updates.length) return "";
  const bytes = mergeSharedUpdates(updates);
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32768)
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
  return btoa(parts.join(""));
}
export function decodeDraftUpdates(value: string) {
  return value ? Uint8Array.from(atob(value), (character) => character.charCodeAt(0)) : null;
}
export function draftProject() {
  return projectModel.active?.id ?? (publicState.publicView ? "public" : appState.currentRoot);
}
export function captureDraft(): DraftSnapshot | null {
  if (!documentSession.current) return null;
  const shared = collaborationState.collaboration?.id === documentSession.id ? collaborationState.collaboration : null;
  if (touched !== documentSession.id && !shared?.localModified && !shared?.recoveryRecord) return null;
  return {
    keep: dirty() || Boolean(shared?.localUpdates.size || shared?.pending.size || shared?.unmerged),
    project: draftProject(),
    document: documentSession.current.id,
    path: documentSession.current.path,
    source: appState.ui.editor.value,
    version: documentSession.current.version,
    room: shared?.room ?? null,
    updates: encodeDraftUpdates(shared ? [...shared.localUpdates.values()] : []),
    unmerged: Boolean(shared?.unmerged),
    selection: collaborativeSelection(),
    tab,
  };
}
export function removeDraftRecord(key: string, generation: string | null = null) {
  return currentDraftOwner().remove(key, generation);
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
      if (snapshot.keep)
        throw new Error(
          "Encrypted local recovery requires HTTPS or localhost. Save or copy unsaved text before leaving this document.",
        );
      return;
    }
    await currentDraftOwner().persist(snapshot, retire);
  } catch (cause) {
    const error = errorContext(cause);
    if (owner && !owner.aborted)
      documentNotice(
        `Local recovery could not be saved: ${error.message} Keep this tab open or copy your text.`,
        "warning",
      );
    else console.warn("Local recovery could not finish after its view was disposed.", error);
    throw error;
  }
}
export const persistCurrentDraft = () => persistAccepted();

export function queueDraftPersistence(local = false): void {
  if (local) touched = documentSession.id;
  if (!localRecoveryAvailable()) return;
  if (draftTimer === null)
    draftTimer = window.setTimeout(() => {
      void persistCurrentDraft().catch(console.error);
    }, 250);
}
export function finishLocalDraft(): void {
  if (
    !documentSession.current ||
    dirty() ||
    collaborationState.collaboration?.localUpdates.size ||
    collaborationState.collaboration?.pending.size ||
    collaborationState.collaboration?.unmerged
  )
    return;
  if (collaborationState.collaboration && !collaborationState.collaboration.initialized) return;
  const pending = persistAccepted(collaborationState.collaboration?.recoveryRecord ?? null);
  touched = null;
  if (collaborationState.collaboration) {
    collaborationState.collaboration.localModified = false;
    collaborationState.collaboration.recoveryRecord = null;
  }
  void pending.catch(console.error);
}
export async function loadDraftForDocument(project: string | null, id: string) {
  return currentDraftOwner().forDocument(project, id);
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
    if (record.source === appState.ui.editor.value && !record.updates) {
      if (!dirty()) await reader.remove(record.key, record.generation);
      return;
    }
    if (
      !collaborationState.collaboration &&
      participationState.documentParticipation &&
      resourceState.documentPermissions?.collaborative &&
      record.room &&
      !record.unmerged
    ) {
      participationState.documentParticipation.recoveryRecord = record;
      collaborationNotice("A local collaborative draft is kept. It will merge when shared editing resumes.");
      return;
    }
    if (collaborationState.collaboration) {
      const shared = collaborationState.collaboration;
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
      documentNotice(`Could not read local recovery: ${errorContext(cause).message}`, "warning");
  }
}

function updateRecoveryControls(record: LocalDraft) {
  appState.element("draft-recovery-apply").disabled =
    applying ||
    !documentSession.current ||
    documentSession.current.id !== record.document ||
    draftProject() !== record.project ||
    !projectWritable();
}
export function showDraftRecovery(record: LocalDraft): void {
  recovery?.cancel();
  selected = record;
  appState.element("draft-recovery-info").textContent = `${record.path} · ${new Date(record.updated).toLocaleString()}`;
  appState.element("draft-recovery-source").value = record.source.slice(0, 200000);
  updateRecoveryControls(record);
  notice(
    appState.element("draft-recovery-error"),
    record.source.length > 200000 ? "Preview truncated. Copy draft preserves the complete text." : "",
  );
  showDialog(appState.element("draft-recovery-dialog"), { restoreParent: true });
}
