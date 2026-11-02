import { authenticationSession } from "../../state/authentication";
import { documentSession } from "../../state/document";
import { shell } from "../../state/shell";
import { requireValue } from "../../types/elements";

import { refreshControls } from "../accounts/authentication";
import { appState, dirty } from "../core/bootstrap";
import { notice, setText } from "../core/dom";
import { listen, onApplicationDispose } from "../lifecycle";
import { publicState } from "../sharing/public";
import {
  collaborationState,
  connectCollaboration,
  saveCollaboration,
  startCollaboration,
  stopCollaboration,
} from "./collaboration";
import { participationState, stopDocumentParticipation } from "./participation";

class PresenceState {
  collaborationUi!: ReturnType<typeof createCollaborationUi>;
  peerColors!: number;
  cursorFrame!: number | null;
}
export const presenceState = new PresenceState();
export function initializeCollaborationPresence(): void {
  presenceState.collaborationUi = createCollaborationUi();
  presenceState.peerColors = 12;
  presenceState.cursorFrame = null;
  onApplicationDispose(() => {
    if (presenceState.cursorFrame !== null) cancelAnimationFrame(presenceState.cursorFrame);
    presenceState.cursorFrame = null;
  });
  listen(document, "selectionchange", () => {
    publishCollaborativeCursor();
    schedulePeerCursors();
  });
  listen(document, "scroll", schedulePeerCursors, true);
  listen(document, "folio-node-panel-layout", schedulePeerCursors);
  listen(window, "resize", schedulePeerCursors);
  listen(appState.compactLayout, "change", renderCollaborators);
  listen(presenceState.collaborationUi.join, "click", () => {
    if (participationState.documentParticipation?.preparing && !collaborationState.collaboration) {
      stopDocumentParticipation();
      collaborationNotice("Automatic collaboration paused for this document. Reopen it to watch for editors.");
      renderCollaborators();
      refreshControls();
      return;
    }
    if (collaborationState.collaboration?.connected) {
      if (dirty() || collaborationState.collaboration.pending.size || collaborationState.collaboration.saving) {
        collaborationNotice("Save all shared changes before leaving collaboration.", true);
        saveCollaboration();
        return;
      }
      stopDocumentParticipation();
      stopCollaboration();
      refreshControls();
    } else if (collaborationState.collaboration) void connectCollaboration(collaborationState.collaboration);
    else void startCollaboration();
  });
}
export function collaborationNotice(message: string, error = false): void {
  notice(presenceState.collaborationUi.message, message, error ? "warning" : "");
}

export function renderCollaborators(): void {
  const current = collaborationState.collaboration;
  const preparing = Boolean(participationState.documentParticipation?.preparing);
  presenceState.collaborationUi.join.hidden =
    !documentSession.current ||
    (!current && !preparing && (authenticationSession.mode === "users" || publicState.publicView));
  presenceState.collaborationUi.join.disabled = Boolean(current?.connecting);
  presenceState.collaborationUi.join.title = current?.connected
    ? "Leave collaborative editing after saving"
    : "Join this note's collaborative session";
  setText(
    presenceState.collaborationUi.join,
    current?.connected
      ? appState.compactLayout.matches
        ? `${Math.max(1, current.users?.length ?? 1)} online`
        : "Collaborating"
      : current
        ? "Reconnect"
        : preparing
          ? "Preparing"
          : "Collaborate",
  );
  presenceState.collaborationUi.join.setAttribute("aria-pressed", String(Boolean(current?.connected)));
  presenceState.collaborationUi.people.replaceChildren();
  const users = current?.users ?? [];
  presenceState.collaborationUi.join.setAttribute(
    "aria-label",
    current?.connected
      ? `Collaborating with ${users.map((user) => user.name).join(", ")}. Leave collaborative editing`
      : presenceState.collaborationUi.join.textContent,
  );
  const limit = appState.compactLayout.matches ? 2 : 5;
  for (const user of users.slice(0, limit)) {
    const avatar = document.createElement("span");
    avatar.className = `collaboration-avatar peer-color-${(user.color ?? 0) % presenceState.peerColors}`;
    avatar.dataset.peer = user.id;
    avatar.setAttribute("role", "img");
    avatar.setAttribute("aria-label", `${user.name}${user.id === requireValue(current).me?.id ? " (you)" : ""}`);
    avatar.title = `${user.name}${user.id === requireValue(current).me?.id ? " (you)" : ""} · ${user.cursor?.mode ?? "online"}`;
    avatar.textContent = user.name.slice(0, 2).toUpperCase();
    presenceState.collaborationUi.people.append(avatar);
  }
  if (users.length > limit) {
    const more = document.createElement("span");
    more.className = "collaboration-avatar";
    more.textContent = `+${users.length - limit}`;
    more.title = users
      .slice(limit)
      .map((user) => user.name)
      .join(", ");
    presenceState.collaborationUi.people.append(more);
  }
  schedulePeerCursors();
}

export function collaborativeSelection() {
  const mode = shell.view;
  if (mode === "rich") return appState.inlineEditor.getSelection();
  if (mode === "editor" || mode === "split") return appState.ui.editor.getSelection();
  return null;
}

export function drawPeerCursors(): void {
  presenceState.cursorFrame = null;
  const current = collaborationState.collaboration;
  const mode = shell.view;
  const fragment = document.createDocumentFragment();
  if (current?.connected && mode !== "preview") {
    const viewport = mode === "rich" ? appState.inlineEditor.viewportRect() : appState.ui.editor.viewportRect();
    for (const user of current.users) {
      if (user.id === current.me?.id || !user.cursor) continue;
      const selection = current.shared.resolve(user.cursor);
      if (!selection) continue;
      const rect =
        mode === "rich" ? appState.inlineEditor.cursorRect(selection.to) : appState.ui.editor.cursorRect(selection.to);
      if (
        !rect ||
        rect.top < viewport.top ||
        rect.bottom > viewport.bottom ||
        rect.left < viewport.left ||
        rect.left > viewport.right
      )
        continue;
      const cursor = document.createElement("span");
      cursor.className = `collaboration-caret peer-color-${(user.color ?? 0) % presenceState.peerColors}`;
      cursor.dataset.peer = user.id;
      cursor.setAttribute("aria-hidden", "true");
      cursor.style.left = `${rect.left}px`;
      cursor.style.top = `${rect.top}px`;
      cursor.style.height = `${Math.max(14, rect.bottom - rect.top)}px`;
      const name = document.createElement("span");
      name.className = "collaboration-caret-name";
      name.textContent = user.name;
      cursor.append(name);
      fragment.append(cursor);
    }
  }
  presenceState.collaborationUi.cursors.replaceChildren(fragment);
}

export function schedulePeerCursors(): void {
  if (presenceState.cursorFrame === null) presenceState.cursorFrame = requestAnimationFrame(drawPeerCursors);
}

export function publishCollaborativeCursor(): void {
  const current = collaborationState.collaboration;
  if (!current?.connected || current.socket?.readyState !== WebSocket.OPEN || current.applying || current.composing)
    return;
  current.selection = current.shared.relative(collaborativeSelection());
  const cursor = current.selection ? { ...current.selection, mode: shell.view } : null;
  const signature = JSON.stringify(cursor);
  if (signature === current.cursorSignature) return;
  current.cursorSignature = signature;
  current.socket.send(JSON.stringify({ type: "cursor", cursor }));
}

function createCollaborationUi() {
  return {
    people: appState.element("collaboration-people"),
    join: appState.element("collaboration-join"),
    message: appState.element("collaboration-message"),
    cursors: appState.element("collaboration-cursors"),
  };
}
