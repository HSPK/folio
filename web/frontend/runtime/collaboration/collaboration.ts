import { projectModel } from "../../state/projects";
import { authenticationSession } from "../../state/authentication";
import { documentSession } from "../../state/document";
import { decodedJoined } from "../../api/contracts";
import { createSharedText } from "@folio/editor-runtime";
import { shell } from "../../state/shell";
import type { Collaboration, DocumentPayload, RelativeSelection } from "../../types/domain";
import { clearTimer, requireValue } from "../../types/elements";
import { errorContext } from "../../types/errors";
import { refreshControls } from "../accounts/authentication";
import { api } from "../core/api";
import { appState, dirty } from "../core/bootstrap";
import { documentNotice, previewStatus } from "../core/dom";
import {
  finishLocalDraft,
  persistCurrentDraft,
  queueDraftPersistence,
  recoverDocumentDraft,
  showDraftRecovery,
} from "../documents/drafts";
import { renderPreview, schedulePreview } from "../documents/preview";
import { rememberResources, resourceState } from "../documents/resources";
import { cancelAutoSave, notifyDocumentSave, SAVE_TIMEOUT_MS } from "../documents/saving";
import { listen, onApplicationDispose } from "../lifecycle";
import { updateFileTitle } from "../navigation/library";

import { projectWritable } from "../projects/permissions";
import { publicState, requestPublicPassword } from "../sharing/public";
import { participationState, stopDocumentParticipation } from "./participation";
import {
  collaborationNotice,
  collaborativeSelection,
  publishCollaborativeCursor,
  renderCollaborators,
  schedulePeerCursors,
} from "./presence";
class CollaborationState {
  collaboration!: Collaboration | null;
  collaborativeTarget!: (target: EventTarget | null) => Element | null | undefined;
}
export const collaborationState = new CollaborationState();
export function initializeCollaborationCollaboration(): void {
  collaborationState.collaboration = null;
  onApplicationDispose(stopCollaboration);
  collaborationState.collaborativeTarget = (target) =>
    target instanceof Element
      ? target.closest<HTMLElement>(
          "#editor, .virtual-source-editor .cm-content, #rich-editor .ProseMirror, .folio-metadata-source",
        )
      : null;
  listen(document, "compositionstart", (event) => {
    if (!(event.target instanceof Element)) return;
    if (collaborationState.collaboration && collaborationState.collaborativeTarget(event.target))
      collaborationState.collaboration.composing = true;
  });
  listen(document, "compositionend", (event) => {
    if (!(event.target instanceof Element)) return;
    if (!collaborationState.collaboration || !collaborationState.collaborativeTarget(event.target)) return;
    const current = collaborationState.collaboration;
    window.setTimeout(() => {
      if (current !== collaborationState.collaboration) return;
      collaborationChanged();
      current.composing = false;
      void drainCollaboration(current);
    }, 0);
  });
  listen(
    document,
    "keydown",
    (event) => {
      if (!(event.target instanceof Element)) return;
      const current = collaborationState.collaboration;
      if (
        !projectWritable() ||
        !current?.initialized ||
        current.composing ||
        current.unmerged ||
        !collaborationState.collaborativeTarget(event.target) ||
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        !["z", "y"].includes(event.key.toLowerCase())
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const selection = current.shared.relative(collaborativeSelection());
      if (event.shiftKey || event.key.toLowerCase() === "y") current.shared.redo();
      else current.shared.undo();
      void displaySharedText(current, selection);
    },
    true,
  );
  listen(window, "pagehide", () => collaborationState.collaboration?.socket?.close());
}
export function collaborationLocked() {
  return Boolean(
    participationState.documentParticipation?.preparing ||
    (collaborationState.collaboration &&
      (!collaborationState.collaboration.initialized ||
        collaborationState.collaboration.connecting ||
        collaborationState.collaboration.applying)),
  );
}
export function pauseCollaboration(): void {
  const current = collaborationState.collaboration;
  if (!current) return;
  void persistCurrentDraft().catch(console.error);
  clearTimer(current.retry);
  const socket = current.socket;
  current.socket = null;
  current.connected = false;
  current.connecting = false;
  current.saving = false;
  finishCollaborationSave(current, false);
  current.users = [];
  current.queue = [];
  socket?.close();
}
export function stopCollaboration(): void {
  const old = collaborationState.collaboration;
  pauseCollaboration();
  collaborationState.collaboration = null;
  if (old) {
    old.closed = true;
    old.shared.destroy();
  }
  appState.inlineEditor.setReadOnly(false);
  collaborationNotice("");
  renderCollaborators();
}
export async function startCollaboration(): Promise<void> {
  if (!documentSession.current || collaborationState.collaboration) return;
  if (
    (authenticationSession.mode === "users" || publicState.publicView) &&
    (!resourceState.documentPermissions?.collaborative || !participationState.documentParticipation?.ready)
  )
    return;
  if (dirty() || documentSession.saving) {
    collaborationNotice("Save this draft before joining collaborative editing.", true);
    return;
  }
  const initial: Omit<Collaboration, "shared"> = {
    id: documentSession.id,
    resource: documentSession.current.id,
    path: documentSession.current.path,
    room: null,
    closed: false,
    connecting: true,
    connected: false,
    applying: false,
    composing: false,
    users: [],
    me: null,
    socket: null,
    retry: null,
    sequence: 0,
    pending: new Map(),
    localUpdates: new Map(),
    localSequence: 0,
    localModified: false,
    queue: [],
    processing: false,
    selection: null,
    recoveryRecord: null,
    cursorSignature: null,
    initialized: false,
    saving: false,
    failed: false,
  };
  const current = Object.assign(initial, { shared: collaborativeModel(initial) });
  collaborationState.collaboration = current;
  cancelAutoSave();
  await recoverDocumentDraft();
  if (current !== collaborationState.collaboration) return;
  await connectCollaboration(current);
}
export function collaborativeModel(current: Omit<Collaboration, "shared">) {
  return createSharedText((update) => {
    const local = ++current.localSequence;
    current.localUpdates.set(local, update);
    current.localModified = true;
    queueDraftPersistence();
    if (!current.connected) return;
    sendCollaborativeUpdate(current, update, [local]);
  });
}
export function sendCollaborativeUpdate(
  current: Omit<Collaboration, "shared">,
  update: Uint8Array,
  local: number[] = [...current.localUpdates.keys()],
): void {
  if (current.socket?.readyState !== WebSocket.OPEN) return;
  const sequence = ++current.sequence;
  const bytes = new Uint8Array(update.length + 4);
  new DataView(bytes.buffer).setUint32(0, sequence, true);
  bytes.set(update, 4);
  current.pending.set(sequence, local);
  current.socket.send(bytes);
}
export async function connectCollaboration(current: Collaboration): Promise<void> {
  if (current !== collaborationState.collaboration || current.closed || current.socket?.readyState === WebSocket.OPEN)
    return;
  if (current.unmerged) {
    collaborationNotice("An unmerged local draft is kept. Copy it before reopening this note.", true);
    return;
  }
  clearTimer(current.retry);
  current.connecting = !current.initialized;
  appState.inlineEditor.setReadOnly(current.connecting);
  collaborationNotice("Connecting collaborative editing…");
  renderCollaborators();
  refreshControls();
  try {
    const joined = await api("/api/collaboration/join", {
      decode: decodedJoined,
      method: "POST",
      body: {
        document: current.resource,
        roomId: current.room,
        participant: participationState.documentParticipation?.participant ?? null,
      },
    });
    if (current !== collaborationState.collaboration) return;
    current.room = joined.roomId;
    const url = new URL(
      publicState.publicView ? "/api/public/collaboration/socket" : "/api/collaboration/socket",
      window.location.href,
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("ticket", joined.ticket);
    if (projectModel.active) url.searchParams.set("project", projectModel.active.id);
    if (publicState.publicView)
      url.searchParams.set("share", requireValue(publicState.publicToken, "Public link identity"));
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    current.socket = socket;
    let snapshot = true;
    socket.onmessage = ({ data }) => {
      if (socket !== current.socket || current !== collaborationState.collaboration) return;
      current.queue.push({ data, snapshot: data instanceof ArrayBuffer && snapshot });
      if (data instanceof ArrayBuffer) snapshot = false;
      void drainCollaboration(current);
    };
    socket.onerror = () => collaborationNotice("Collaborative connection failed. Your local text is kept.", true);
    socket.onclose = () => {
      if (current !== collaborationState.collaboration || current.closed || socket !== current.socket) return;
      current.connected = false;
      current.connecting = false;
      current.saving = false;
      finishCollaborationSave(current, false);
      current.users = [];
      current.queue = [];
      appState.inlineEditor.setReadOnly(!current.initialized);
      collaborationNotice(
        current.unmerged
          ? "An unmerged local draft is kept. Copy it before reopening this note."
          : "Collaboration disconnected. Local edits are kept; reconnecting…",
        true,
      );
      renderCollaborators();
      refreshControls();
      if (!current.unmerged) current.retry = window.setTimeout(() => void connectCollaboration(current), 2000);
    };
  } catch (errorCause) {
    const error = errorContext(errorCause);
    if (current !== collaborationState.collaboration) return;
    current.connecting = false;
    if (error.status === 425) {
      current.retry = window.setTimeout(() => void connectCollaboration(current), 1000);
      return;
    }
    if (error.status === 403 || error.status === 401) current.writable = false;
    appState.inlineEditor.setReadOnly(!current.initialized);
    collaborationNotice(`Could not join collaboration: ${error.message}`, true);
    renderCollaborators();
    refreshControls();
    if (publicState.publicView && error.status === 401) requestPublicPassword();
    if (current.recoveryRecord) showDraftRecovery(current.recoveryRecord);
  }
}
export function collaborationChanged(): void {
  const current = collaborationState.collaboration;
  if (!current || current.applying || !current.initialized || !projectWritable()) return;
  try {
    current.shared.replace(appState.ui.editor.value);
    if (current.unmerged) {
      current.unmerged = null;
      current.failed = false;
      void connectCollaboration(current);
    }
    current.selection = current.shared.relative(collaborativeSelection());
    publishCollaborativeCursor();
  } catch (errorCause) {
    const error = errorContext(errorCause);
    current.failed = true;
    current.unmerged = appState.ui.editor.value;
    current.socket?.close();
    collaborationNotice(`${error.message} Your local text is kept.`, true);
  }
}
export function saveCollaboration() {
  if (!projectWritable()) return Promise.resolve(false);
  const current = collaborationState.collaboration;
  if (!current?.connected) {
    collaborationNotice("Not saved: collaboration is disconnected. Your local edits are kept.", true);
    return Promise.resolve(false);
  }
  if (current.failed) {
    collaborationNotice("Reconnect shared editing before saving. Your local text is kept.", true);
    return Promise.resolve(false);
  }
  if (current.saveCompletion) {
    current.saveAgain = true;
    return current.saveCompletion;
  }
  const completion = new Promise<boolean>((resolve) => {
    current.finishSave_fn = resolve;
  });
  current.saveCompletion = completion;
  current.saveTimer = window.setTimeout(() => {
    if (current !== collaborationState.collaboration || !current.saveCompletion) return;
    current.saving = false;
    collaborationNotice("Shared saving timed out. Your local text is kept; retry saving.", true);
    finishCollaborationSave(current, false);
    refreshControls();
  }, SAVE_TIMEOUT_MS);
  current.saving = true;
  try {
    requireValue(current.socket).send(JSON.stringify({ type: "save" }));
  } catch (errorCause) {
    const error = errorContext(errorCause);
    current.saving = false;
    collaborationNotice(`Could not request shared saving: ${error.message}. Your text is kept.`, true);
    finishCollaborationSave(current, false);
  }
  refreshControls();
  return completion;
}
export function finishCollaborationSave(current: Collaboration, saved: boolean): void {
  clearTimer(current.saveTimer);
  const resolve = current.finishSave_fn;
  const again = current.saveAgain;
  current.saveCompletion = null;
  current.finishSave_fn = null;
  current.saveAgain = false;
  if (saved && again && current === collaborationState.collaboration && (dirty() || current.pending.size))
    void saveCollaboration();
  resolve?.(saved);
  notifyDocumentSave();
}
export function collaborativeSaved(current: Collaboration, payload: DocumentPayload): void {
  if (current !== collaborationState.collaboration || payload.path !== current.path) return;
  rememberResources(payload, projectModel.active?.id ?? "local");
  documentSession.acceptRemote(payload, appState.currentRoot);
  current.saving = false;
  updateFileTitle(payload.path, payload.title);
  refreshControls();
  if (!dirty()) {
    cancelAutoSave();
    renderPreview(payload.html);
    previewStatus("Up to date");
  }
  if (payload.warning) documentNotice(payload.warning, "warning");
  queueDraftPersistence();
  finishLocalDraft();
  finishCollaborationSave(current, true);
}
export async function displaySharedText(current: Collaboration, selection: RelativeSelection): Promise<void> {
  const next = current.shared.value;
  if (appState.ui.editor.value !== next) {
    current.applying = true;
    appState.inlineEditor.setReadOnly(true);
    const focus = document.activeElement;
    const inEditor = Boolean(focus?.closest<HTMLElement>("#rich-editor, .editor-pane"));
    try {
      appState.ui.editor.value = next;
      documentSession.edited();
      if (shell.view === "rich") {
        if (!(await appState.inlineEditor.replaceSource(next))) {
          await appState.inlineEditor.load(next, current.path);
        }
      }
      if (current !== collaborationState.collaboration) return;
      current.applying = false;
      appState.inlineEditor.setReadOnly(false);
      refreshControls();
      const restored = current.shared.resolve(selection);
      if (restored && inEditor) {
        if (shell.view === "rich") appState.inlineEditor.select(restored.from, restored.to);
        else {
          appState.ui.editor.setSelectionRange(restored.from, restored.to);
          appState.ui.editor.focus({ preventScroll: true });
        }
      }
      schedulePreview();
    } finally {
      current.applying = false;
      if (current === collaborationState.collaboration) {
        appState.inlineEditor.setReadOnly(false);
        refreshControls();
      }
    }
  }
  schedulePeerCursors();
}
export async function drainCollaboration(current: Collaboration): Promise<void> {
  if (current.processing || current.composing || current.unmerged || current !== collaborationState.collaboration)
    return;
  current.processing = true;
  try {
    while (current.queue.length && !current.composing && current === collaborationState.collaboration) {
      const message = current.queue.shift();
      if (!message) break;
      const { data, snapshot } = message;
      if (data instanceof ArrayBuffer) {
        const selection = current.initialized ? current.shared.relative(collaborativeSelection()) : null;
        const update = new Uint8Array(data, 4);
        current.shared.apply(update);
        if (snapshot) {
          const reconnect = current.initialized;
          current.connecting = false;
          current.connected = true;
          current.initialized = true;
          current.pending.clear();
          current.cursorSignature = null;
          appState.inlineEditor.setReadOnly(false);
          if ((reconnect || current.localUpdates.size) && current.writable !== false) {
            sendCollaborativeUpdate(current, current.shared.changesSince(update));
          }
          collaborationNotice(
            current.failed
              ? "This collaborative draft could not be saved. Copy your shared edits before reopening the note."
              : "",
            current.failed,
          );
          renderCollaborators();
        }
        await displaySharedText(current, selection);
        current.selection = current.shared.relative(collaborativeSelection());
        publishCollaborativeCursor();
        refreshControls();
        finishLocalDraft();
      } else {
        const message = JSON.parse(data);
        if (message.type === "welcome") {
          current.me = message.me;
          current.users = message.users;
          current.failed = message.blocked;
          current.writable = message.writable;
          if (!message.writable && current.recoveryRecord) {
            const record = current.recoveryRecord;
            current.shared.destroy();
            current.shared = collaborativeModel(current);
            current.localUpdates.clear();
            current.localModified = false;
            current.recoveryRecord = null;
            showDraftRecovery(record);
          }
          collaborativeSaved(current, message.saved);
        } else if (message.type === "presence") {
          current.users = message.users;
          renderCollaborators();
        } else if (message.type === "reset") {
          await persistCurrentDraft().catch((error) =>
            console.error("Could not preserve the draft before a document reset.", error),
          );
          stopDocumentParticipation();
          if (resourceState.documentPermissions)
            resourceState.documentPermissions = {
              ...resourceState.documentPermissions,
              writable: false,
              collaborative: false,
            };
          current.closed = true;
          current.connected = false;
          current.saving = false;
          finishCollaborationSave(current, false);
          current.writable = false;
          current.users = [];
          collaborationNotice(message.message, true);
          renderCollaborators();
          refreshControls();
        } else if (message.type === "ack") {
          for (const local of current.pending.get(message.sequence) ?? []) current.localUpdates.delete(local);
          current.pending.delete(message.sequence);
          queueDraftPersistence();
          finishLocalDraft();
          notifyDocumentSave();
        } else if (message.type === "saved") {
          collaborativeSaved(current, message.document);
        } else if (message.type === "error") {
          current.saving = false;
          current.failed = true;
          finishCollaborationSave(current, false);
          collaborationNotice(message.message, true);
        }
      }
    }
  } catch (errorCause) {
    const error = errorContext(errorCause);
    current.failed = true;
    finishCollaborationSave(current, false);
    collaborationNotice(`Collaboration could not apply an update: ${error.message}. Your local text is kept.`, true);
    current.socket?.close();
  } finally {
    current.processing = false;
  }
}
