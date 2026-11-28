import { projectModel } from "../../state/projects";
import { authenticationSession } from "../../state/authentication";
import { documentSession } from "../../state/document";
import { decodedJoined } from "../../api/contracts";
import { createSharedText } from "@folio/editor-runtime";
import { shell } from "../../state/shell";
import type { Collaboration, DocumentPayload, RelativeSelection } from "../../types/domain";
import { clearTimer, requireValue } from "../../types/elements";
import { errorContext } from "../../types/errors";
import { connectionFailure, refreshControls } from "../accounts/authentication";
import { connectivity, isConnectionLoss } from "../core/recovery";
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
import { documentParticipation, stopDocumentParticipation } from "./participation";
import {
  collaborationNotice,
  collaborativeSelection,
  publishCollaborativeCursor,
  renderCollaborators,
  schedulePeerCursors,
} from "./presence";
export let collaboration: Collaboration | null;
export let collaborativeTarget: (target: EventTarget | null) => Element | null | undefined;

export function initializeCollaborationCollaboration(): void {
  collaboration = null;
  onApplicationDispose(stopCollaboration);
  collaborativeTarget = (target) =>
    target instanceof Element
      ? target.closest<HTMLElement>("#editor, .virtual-source-editor .cm-content, #rich-editor .ProseMirror")
      : null;
  listen(document, "compositionstart", (event) => {
    if (!(event.target instanceof Element)) return;
    if (collaboration && collaborativeTarget(event.target)) collaboration.composing = true;
  });
  listen(document, "compositionend", (event) => {
    if (!(event.target instanceof Element)) return;
    if (!collaboration || !collaborativeTarget(event.target)) return;
    const current = collaboration;
    window.setTimeout(() => {
      if (current !== collaboration) return;
      collaborationChanged();
      current.composing = false;
      void drainCollaboration(current);
    }, 0);
  });
  const history = (event: Event, kind: "undo" | "redo") => {
    if (!event.cancelable || !documentSession.current || !projectWritable() || !collaborativeTarget(event.target))
      return;
    const current = collaboration;
    const live = appState.inlineEditor;
    if (shell.view === "rich") live.flushInput();
    if (current) {
      // Never fall through to a surface's private history while the room is locked.
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!current.initialized || current.composing || current.unmerged || current.applying) return;
      const selection = current.shared.relative(collaborativeSelection());
      current.shared[kind]();
      void displaySharedText(current, selection);
    } else if (shell.view === "rich" && live.isReady() && !live.hasHistory(kind)) {
      // ProseMirror keeps its native step/selection semantics for edits from this mount.
      // Beyond that boundary, replay the same Markdown history as Source.
      event.preventDefault();
      event.stopImmediatePropagation();
      const source = appState.editor;
      if (!source.runHistory(kind)) return;
      const selection = source.getSelection();
      if (live.replaceSource(source.value, true)) live.select(selection.from, selection.to, false, false);
      else void live.load(source.value, documentSession.current.path);
    }
  };
  listen(
    document,
    "keydown",
    (event) => {
      if (event.isComposing || !(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "z" || key === "y") history(event, event.shiftKey || key === "y" ? "redo" : "undo");
    },
    true,
  );
  listen(
    document,
    "beforeinput",
    (event) => {
      if (!(event instanceof InputEvent) || event.isComposing) return;
      if (event.inputType === "historyUndo") history(event, "undo");
      if (event.inputType === "historyRedo") history(event, "redo");
    },
    true,
  );
  listen(window, "pagehide", () => collaboration?.socket?.close());
}
export function collaborationLocked() {
  return Boolean(
    documentParticipation?.preparing ||
    (collaboration && (!collaboration.initialized || collaboration.connecting || collaboration.applying)),
  );
}
export function pauseCollaboration(): void {
  connectivity.roomLost = false;
  const current = collaboration;
  if (!current) return;
  void persistCurrentDraft().catch(console.error);
  clearTimer(current.retry);
  current.retry = null;
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
  const old = collaboration;
  pauseCollaboration();
  collaboration = null;
  if (old) {
    old.closed = true;
    old.shared.destroy();
  }
  appState.inlineEditor.setReadOnly(false);
  collaborationNotice("");
  renderCollaborators();
}
export async function startCollaboration(): Promise<void> {
  if (!documentSession.current || !documentSession.resourceId || collaboration) return;
  if (
    (authenticationSession.mode === "users" || publicState.publicView) &&
    (!resourceState.documentPermissions?.collaborative || !documentParticipation?.ready)
  )
    return;
  if (dirty() || documentSession.saving) {
    collaborationNotice("Save draft before joining", true);
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
    recoveryRecord: null,
    cursorSignature: null,
    initialized: false,
    saving: false,
    failed: false,
  };
  const current = Object.assign(initial, { shared: collaborativeModel(initial) });
  collaboration = current;
  cancelAutoSave();
  await recoverDocumentDraft();
  if (current !== collaboration) return;
  await connectCollaboration(current);
}
function collaborativeModel(current: Omit<Collaboration, "shared">) {
  return createSharedText((update) => {
    const local = ++current.localSequence;
    current.localUpdates.set(local, update);
    current.localModified = true;
    queueDraftPersistence();
    if (!current.connected) return;
    sendCollaborativeUpdate(current, update, [local]);
  });
}
function sendCollaborativeUpdate(
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
const joining = new WeakSet<Collaboration>();
export async function connectCollaboration(current: Collaboration): Promise<void> {
  if (
    current !== collaboration ||
    current.closed ||
    joining.has(current) ||
    current.socket?.readyState === WebSocket.OPEN ||
    current.socket?.readyState === WebSocket.CONNECTING
  )
    return;
  if (current.unmerged) {
    collaborationNotice("Your edits are still here. Copy them before reloading.", true);
    return;
  }
  clearTimer(current.retry);
  current.retry = null;
  joining.add(current);
  current.connecting = !current.initialized;
  appState.inlineEditor.setReadOnly(current.connecting);
  if (!connectivity.roomLost && !connectivity.serviceLost) collaborationNotice("Connecting…");
  renderCollaborators();
  refreshControls();
  try {
    const joined = await api("/api/collaboration/join", {
      decode: decodedJoined,
      method: "POST",
      body: {
        document: current.resource,
        roomId: current.room,
        participant: documentParticipation?.participant ?? null,
      },
    });
    if (current !== collaboration) return;
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
      if (socket !== current.socket || current !== collaboration) return;
      current.queue.push({ data, snapshot: data instanceof ArrayBuffer && snapshot });
      if (data instanceof ArrayBuffer) snapshot = false;
      void drainCollaboration(current);
    };
    socket.onclose = () => {
      if (current !== collaboration || current.closed || socket !== current.socket) return;
      current.connected = false;
      current.connecting = false;
      current.saving = false;
      finishCollaborationSave(current, false);
      current.users = [];
      current.queue = [];
      appState.inlineEditor.setReadOnly(!current.initialized);
      connectivity.roomLost = !current.unmerged;
      collaborationNotice(current.unmerged ? "Your edits are still here. Copy them before reloading." : "", true);
      renderCollaborators();
      refreshControls();
      if (!current.unmerged) current.retry = window.setTimeout(() => void connectCollaboration(current), 2000);
    };
  } catch (errorCause) {
    const error = errorContext(errorCause);
    if (current !== collaboration) return;
    current.connecting = false;
    if (error.status === 425) {
      current.retry = window.setTimeout(() => void connectCollaboration(current), 1000);
      return;
    }
    if (isConnectionLoss(error)) {
      connectivity.roomLost = true;
      collaborationNotice("");
      connectionFailure(error);
      current.retry = window.setTimeout(() => void connectCollaboration(current), 3000);
      return;
    }
    connectivity.roomLost = false;
    if (error.status === 403 || error.status === 401) current.writable = false;
    appState.inlineEditor.setReadOnly(!current.initialized);
    collaborationNotice(`Join failed: ${error.message}`, true);
    renderCollaborators();
    refreshControls();
    if (publicState.publicView && error.status === 401) requestPublicPassword();
    if (current.recoveryRecord) showDraftRecovery(current.recoveryRecord);
  } finally {
    joining.delete(current);
  }
}
export function collaborationChanged(): void {
  const current = collaboration;
  if (!current || current.applying || !current.initialized || !projectWritable()) return;
  try {
    current.shared.replace(appState.editor.value);
    if (current.unmerged) {
      current.unmerged = null;
      current.failed = false;
      void connectCollaboration(current);
    }
    publishCollaborativeCursor();
  } catch (errorCause) {
    const error = errorContext(errorCause);
    current.failed = true;
    current.unmerged = appState.editor.value;
    current.socket?.close();
    collaborationNotice(error.message, true);
  }
}
export function saveCollaboration() {
  if (!projectWritable()) return Promise.resolve(false);
  const current = collaboration;
  if (!current?.connected) {
    if (!connectivity.roomLost && !connectivity.serviceLost) collaborationNotice("Not connected, not saved", true);
    return Promise.resolve(false);
  }
  if (current.failed) {
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
    if (current !== collaboration || !current.saveCompletion) return;
    current.saving = false;
    collaborationNotice("Shared save timed out", true);
    finishCollaborationSave(current, false);
    refreshControls();
  }, SAVE_TIMEOUT_MS);
  current.saving = true;
  try {
    requireValue(current.socket).send(JSON.stringify({ type: "save" }));
  } catch (errorCause) {
    const error = errorContext(errorCause);
    current.saving = false;
    collaborationNotice(`Save failed: ${error.message}`, true);
    finishCollaborationSave(current, false);
  }
  refreshControls();
  return completion;
}
function finishCollaborationSave(current: Collaboration, saved: boolean): void {
  clearTimer(current.saveTimer);
  const resolve = current.finishSave_fn;
  const again = current.saveAgain;
  current.saveCompletion = null;
  current.finishSave_fn = null;
  current.saveAgain = false;
  if (saved && again && current === collaboration && (dirty() || current.pending.size)) void saveCollaboration();
  resolve?.(saved);
  notifyDocumentSave();
}
function collaborativeSaved(current: Collaboration, payload: DocumentPayload): void {
  if (current !== collaboration || payload.path !== current.path) return;
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
async function displaySharedText(current: Collaboration, selection: RelativeSelection): Promise<void> {
  const next = current.shared.value;
  if (appState.editor.value !== next) {
    current.applying = true;
    try {
      appState.editor.value = next;
      documentSession.edited();
      if (shell.view === "rich" && !appState.inlineEditor.replaceSource(next)) {
        refreshControls();
        await appState.inlineEditor.load(next, current.path);
      }
      if (current !== collaboration) return;
      const restored = current.shared.resolve(selection);
      if (restored) {
        if (shell.view === "rich") appState.inlineEditor.select(restored.from, restored.to, false, false);
        else if (shell.view !== "preview") appState.editor.setSelectionRange(restored.from, restored.to);
      }
      schedulePreview();
    } finally {
      current.applying = false;
      if (current === collaboration) refreshControls();
    }
  }
  schedulePeerCursors();
}
async function drainCollaboration(current: Collaboration): Promise<void> {
  if (current.processing || current.composing || current.unmerged || current !== collaboration) return;
  current.processing = true;
  try {
    while (current.queue.length && !current.composing && current === collaboration) {
      const message = current.queue.shift();
      if (!message) break;
      const { data, snapshot } = message;
      if (data instanceof ArrayBuffer) {
        if (current.initialized && shell.view === "rich") appState.inlineEditor.flushInput();
        const selection = current.initialized ? current.shared.relative(collaborativeSelection()) : null;
        const update = new Uint8Array(data, 4);
        current.shared.apply(update);
        if (snapshot) {
          const reconnect = current.initialized;
          if (!reconnect && !current.recoveryRecord && current.id === documentSession.id) {
            current.shared.adoptSoloHistory(appState.editor.historyState());
          }
          current.connecting = false;
          current.connected = true;
          connectivity.roomLost = false;
          current.initialized = true;
          current.pending.clear();
          current.cursorSignature = null;
          appState.inlineEditor.setReadOnly(false);
          if ((reconnect || current.localUpdates.size) && current.writable !== false) {
            sendCollaborativeUpdate(current, current.shared.changesSince(update));
          }
          collaborationNotice(current.failed ? "Shared draft not saved" : "", current.failed);
          renderCollaborators();
        }
        await displaySharedText(current, selection);
        publishCollaborativeCursor();
        if (snapshot) refreshControls();
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
    collaborationNotice(`Update failed: ${error.message}`, true);
    current.socket?.close();
  } finally {
    current.processing = false;
  }
}
