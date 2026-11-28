import { authenticationSession } from "../../state/authentication";
import { documentSession } from "../../state/document";
import { shell } from "../../state/shell";
import { element, requireValue } from "../../types/elements";

import { refreshControls } from "../accounts/authentication";
import { appState, dirty } from "../core/bootstrap";
import { notice, setText } from "../core/dom";
import { listen, onApplicationDispose } from "../lifecycle";
import { publicState } from "../sharing/public";
import {
  collaboration,
  connectCollaboration,
  saveCollaboration,
  startCollaboration,
  stopCollaboration,
} from "./collaboration";
import { documentParticipation, stopDocumentParticipation } from "./participation";

let peerColors: number;
let cursorFrame: number | null;

export function initializeCollaborationPresence(): void {
  peerColors = 12;
  cursorFrame = null;
  onApplicationDispose(() => {
    if (cursorFrame !== null) cancelAnimationFrame(cursorFrame);
    cursorFrame = null;
  });
  listen(document, "selectionchange", () => {
    publishCollaborativeCursor();
    schedulePeerCursors();
  });
  listen(element("document-panes"), "scroll", schedulePeerCursors, true);
  listen(document, "folio-node-panel-layout", schedulePeerCursors);
  listen(window, "resize", schedulePeerCursors);
  listen(appState.compactLayout, "change", renderCollaborators);
  listen(element("collaboration-join"), "click", () => {
    if (documentParticipation?.preparing && !collaboration) {
      stopDocumentParticipation();
      collaborationNotice("Collaboration paused");
      renderCollaborators();
      refreshControls();
      return;
    }
    if (collaboration?.connected) {
      if (dirty() || collaboration.pending.size || collaboration.saving) {
        collaborationNotice("Save shared changes first", true);
        saveCollaboration();
        return;
      }
      stopDocumentParticipation();
      stopCollaboration();
      refreshControls();
    } else if (collaboration) void connectCollaboration(collaboration);
    else void startCollaboration();
  });
}
export function collaborationNotice(message: string, error = false): void {
  notice(element("collaboration-message"), message, error ? "warning" : "");
}

export function renderCollaborators(): void {
  const current = collaboration;
  const preparing = Boolean(documentParticipation?.preparing);
  element("collaboration-join").hidden =
    !documentSession.resourceId ||
    (!current && !preparing && (authenticationSession.mode === "users" || publicState.publicView));
  element("collaboration-join").disabled = Boolean(current?.connecting);
  element("collaboration-join").title = current?.connected
    ? "Leave collaborative editing after saving"
    : "Join this note's collaborative session";
  setText(
    element("collaboration-join"),
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
  element("collaboration-join").setAttribute("aria-pressed", String(Boolean(current?.connected)));
  const people = element("collaboration-people");
  const users = current?.users ?? [];
  element("collaboration-join").setAttribute(
    "aria-label",
    current?.connected
      ? `Collaborating with ${users.map((user) => user.name).join(", ")}. Leave collaborative editing`
      : element("collaboration-join").textContent,
  );
  const limit = appState.compactLayout.matches ? 2 : 5;
  for (const [index, user] of users.slice(0, limit).entries()) {
    let avatar = people.children[index] as HTMLElement | undefined;
    if (avatar?.dataset.peer !== user.id) {
      const element = document.createElement("span");
      element.dataset.peer = user.id;
      element.setAttribute("role", "img");
      if (avatar) avatar.replaceWith(element);
      else people.append(element);
      avatar = element;
    }
    const color = `collaboration-avatar peer-color-${(user.color ?? 0) % peerColors}`;
    const label = `${user.name}${user.id === requireValue(current).me?.id ? " (you)" : ""}`;
    const title = `${label} · ${user.cursor?.mode ?? "online"}`;
    if (avatar.className !== color) avatar.className = color;
    if (avatar.getAttribute("aria-label") !== label) avatar.setAttribute("aria-label", label);
    if (avatar.title !== title) avatar.title = title;
    setText(avatar, user.name.slice(0, 2).toUpperCase());
  }
  if (users.length > limit) {
    let more = people.children[limit] as HTMLElement | undefined;
    if (!more || more.dataset.peer) {
      const element = document.createElement("span");
      element.className = "collaboration-avatar";
      if (more) more.replaceWith(element);
      else people.append(element);
      more = element;
    }
    setText(more, `+${users.length - limit}`);
    const title = users
      .slice(limit)
      .map((user) => user.name)
      .join(", ");
    if (more.title !== title) more.title = title;
  }
  while (people.children.length > Math.min(users.length, limit + 1)) people.lastElementChild!.remove();
  schedulePeerCursors();
}

export function collaborativeSelection() {
  const mode = shell.view;
  if (mode === "rich") return appState.inlineEditor.getSelection();
  if (mode === "editor" || mode === "split") return appState.editor.getSelection();
  return null;
}

function drawPeerCursors(): void {
  cursorFrame = null;
  const current = collaboration;
  const mode = shell.view;
  const container = element("collaboration-cursors");
  const remaining = new Map(
    Array.from(container.children, (node) => {
      const cursor = node as HTMLElement;
      return [cursor.dataset.peer!, cursor] as const;
    }),
  );
  const visible = [];
  if (current?.connected && mode !== "preview") {
    const viewport = mode === "rich" ? appState.inlineEditor.viewportRect() : appState.editor.viewportRect();
    for (const user of current.users) {
      if (user.id === current.me?.id || !user.cursor) continue;
      const selection = current.shared.resolve(user.cursor);
      if (!selection) continue;
      const rect =
        mode === "rich" ? appState.inlineEditor.cursorRect(selection.to) : appState.editor.cursorRect(selection.to);
      if (
        !rect ||
        rect.top < viewport.top ||
        rect.bottom > viewport.bottom ||
        rect.left < viewport.left ||
        rect.left > viewport.right
      )
        continue;
      visible.push({ user, rect });
    }
  }
  // Finish measuring all editors before moving any overlays.
  for (const { user, rect } of visible) {
    let cursor = remaining.get(user.id);
    if (!cursor) {
      cursor = document.createElement("span");
      cursor.dataset.peer = user.id;
      cursor.setAttribute("aria-hidden", "true");
      const name = document.createElement("span");
      name.className = "collaboration-caret-name";
      cursor.append(name);
      container.append(cursor);
    }
    remaining.delete(user.id);
    const color = `collaboration-caret peer-color-${(user.color ?? 0) % peerColors}`;
    if (cursor.className !== color) cursor.className = color;
    const label = cursor.firstElementChild!;
    if (label.textContent !== user.name) label.textContent = user.name;
    cursor.style.left = `${rect.left}px`;
    cursor.style.top = `${rect.top}px`;
    cursor.style.height = `${Math.max(14, rect.bottom - rect.top)}px`;
  }
  for (const node of remaining.values()) node.remove();
}

export function schedulePeerCursors(): void {
  const current = collaboration;
  if (
    !element("collaboration-cursors").childElementCount &&
    !(current?.connected && current.users.some((user) => user.id !== current.me?.id && user.cursor))
  )
    return;
  if (cursorFrame === null) cursorFrame = requestAnimationFrame(drawPeerCursors);
}

export function publishCollaborativeCursor(): void {
  const current = collaboration;
  if (!current?.connected || current.socket?.readyState !== WebSocket.OPEN || current.applying || current.composing)
    return;
  const selection = current.shared.relative(collaborativeSelection());
  const cursor = selection ? { ...selection, mode: shell.view } : null;
  const signature = JSON.stringify(cursor);
  if (signature === current.cursorSignature) return;
  current.cursorSignature = signature;
  current.socket.send(JSON.stringify({ type: "cursor", cursor }));
}
