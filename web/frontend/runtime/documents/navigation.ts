import { loadProjectCatalog as loadProjects } from "../projects/gateway";
import { projectModel } from "../../state/projects";
import { authenticationSession } from "../../state/authentication";
import { documentSession } from "../../state/document";
import { decodedDocument } from "../../api/contracts";
import { createDocumentModel, isResourceId, makeNoteUrl } from "@folio/model";
import { shell } from "../../state/shell";
import type { DocumentPayload, RouteMode, ViewPosition } from "../../types/domain";
import { errorContext } from "../../types/errors";
import { connectionFailure, expectDocument, refreshControls, setSidebar } from "../accounts/authentication";
import { stopCollaboration } from "../collaboration/collaboration";
import { startDocumentParticipation, stopDocumentParticipation } from "../collaboration/participation";
import { renderCollaborators } from "../collaboration/presence";
import { api } from "../core/api";
import { appState, dirty, rootChanged } from "../core/bootstrap";
import { ApiError, aborted, documentNotice, notice, previewStatus } from "../core/dom";
import { updateFileSelection } from "../navigation/library";
import { prefetchedDocument } from "../navigation/tree";
import { allowProjectNavigation, closeProjectManager, projectManagerOpen } from "../projects/dialog";
import { switchProject } from "../projects/projects";
import { publicState } from "../sharing/public";
import { noteVisited } from "../workspace/workspace";
import { loadInlineEditorAfterPaint } from "./live";
import {
  emptyPreview,
  invalidatePreview,
  previewState,
  renderPreview,
  schedulePreview,
  scrollToHeading,
} from "./preview";
import { documentReadUrl, documentResource, resourceState, validatedDocumentPermissions } from "./resources";
import {
  cancelAutoSave,
  cancelDocumentTransition,
  prepareDocumentLeave,
  saveBeforeLeaving,
  scheduleAutoSave,
} from "./saving";
class DocumentState {
  pendingViewPosition!: ViewPosition | null;
}
export const documentState = new DocumentState();
export function initializeDocumentsNavigation(): void {
  documentState.pendingViewPosition = null;
}
export function restoreCommittedUrl(): void {
  if (window.location.href !== appState.committedUrl) {
    window.history.replaceState(window.history.state, "", appState.committedUrl);
  }
}
export function commitUrl(url: URL, mode = "push"): void {
  if (mode === "push" && url.href !== appState.committedUrl) window.history.pushState(null, "", url);
  else if (window.location.href !== url.href) window.history.replaceState(window.history.state, "", url);
  appState.committedUrl = url.href;
}
export function cancelDocumentLoad(restoreRoute = true) {
  const previous = documentSession.cancelLoad();
  if (!previous) return false;
  notice(appState.ui.loadingMessage, "");
  if (restoreRoute && previous.mode === "pop") restoreCommittedUrl();
  refreshControls();
  if (documentSession.current) schedulePreview(0);
  return true;
}
export async function confirmDiscard(action: string) {
  return prepareDocumentLeave(action, "discard");
}
export function internalNoteUrl(url: URL) {
  return (
    url.origin === window.location.origin &&
    (((url.pathname === "/" || url.pathname === "/index.html") && isResourceId(url.searchParams.get("document"))) ||
      (publicState.publicView &&
        url.pathname === "/share" &&
        url.searchParams.get("share") === publicState.publicToken))
  );
}
export function useDocument(payload: DocumentPayload, root: string | null, url: URL, mode: RouteMode): void {
  cancelDocumentTransition();
  const nextDocument = { ...createDocumentModel(payload), root };
  const permissions = payload.permissions ? validatedDocumentPermissions(payload.permissions) : null;
  commitUrl(makeNoteUrl(url, payload.id, url.hash), mode);
  stopDocumentParticipation();
  stopCollaboration();
  cancelAutoSave();
  invalidatePreview();
  appState.pendingHeading = null;
  documentSession.open(nextDocument);
  notice(appState.ui.loadingMessage, "");
  resourceState.documentPermissions = permissions;
  // Scroll the tree before replacing editor content, avoiding a forced large-document layout.
  updateFileSelection();
  appState.ui.editor.reset(nextDocument.text);
  void startDocumentParticipation();
  renderCollaborators();
  if (["editor", "split"].includes(shell.view)) appState.ui.editor.prepare();
  notice(appState.element("rich-warning"), "");
  loadInlineEditorAfterPaint();
  notice(appState.ui.conflictMessage, "");
  documentNotice("");
  renderPreview(payload.html, true);
  previewStatus("Up to date");
  refreshControls();
  noteVisited();
  if (appState.compactLayout.matches) setSidebar(false);
  const id = documentSession.id;
  window.requestAnimationFrame(() => {
    if (id !== documentSession.id) return;
    appState.ui.editor.scrollTop = 0;
    scrollToHeading(url.hash);
  });
}
export function clearDocument(url: URL, mode: RouteMode): void {
  cancelDocumentTransition();
  stopDocumentParticipation();
  stopCollaboration();
  cancelAutoSave();
  invalidatePreview();
  appState.pendingHeading = null;
  documentSession.close();
  notice(appState.ui.loadingMessage, "");
  resourceState.documentPermissions = null;
  previewState.deferredPreview = null;
  appState.renderedPreviewDocument = null;
  appState.renderedPreviewRevision = -1;
  appState.ui.editor.reset("");
  appState.inlineEditorPath = null;
  appState.inlineEditor.clear();
  notice(appState.element("rich-warning"), "");
  notice(appState.ui.conflictMessage, "");
  documentNotice("");
  emptyPreview("A place for your Markdown", "Open a file from the list, or create a new note.");
  previewStatus("Select a note to begin");
  commitUrl(url, mode);
  refreshControls();
  updateFileSelection();
}
export async function navigateTo(
  path: string | null,
  hash = "",
  {
    mode = "push",
    url,
    reload = false,
  }: {
    mode?: RouteMode;
    url?: URL | null;
    reload?: boolean;
  } = {},
) {
  let targetUrl = url ?? new URL(appState.committedUrl);
  if (
    authenticationSession.mode === "users" &&
    targetUrl.searchParams.get("project") &&
    targetUrl.searchParams.get("project") !== projectModel.active?.id
  ) {
    await loadProjects();
    return switchProject(targetUrl.searchParams.get("project"), { url: targetUrl, mode });
  }
  const leavingProjects = projectManagerOpen();
  if (leavingProjects && !(await allowProjectNavigation())) {
    if (mode === "pop") restoreCommittedUrl();
    return false;
  }
  cancelDocumentLoad(mode !== "pop");
  if (!reload && (path === documentSession.current?.id || path === documentSession.current?.path) && !rootChanged()) {
    if (leavingProjects) closeProjectManager();
    targetUrl = makeNoteUrl(targetUrl, documentSession.current.id, hash);
    commitUrl(targetUrl, mode);
    scrollToHeading(hash);
    return true;
  }
  if (appState.creating) {
    documentNotice("Please wait for the current creation to finish before changing notes.");
    if (mode === "pop") restoreCommittedUrl();
    return false;
  }
  const action = reload ? "reload this note from disk" : path ? "open another note" : "close this note";
  if (!(reload ? await confirmDiscard(action) : await saveBeforeLeaving(action))) {
    if (mode === "pop") restoreCommittedUrl();
    return false;
  }
  if (leavingProjects) closeProjectManager();
  if (appState.ui.newDialog.open) appState.ui.newDialog.close();
  if (!path) {
    clearDocument(makeNoteUrl(targetUrl, null), mode);
    return true;
  }
  if (appState.connectionState !== "ready") {
    documentNotice(
      "This tab is disconnected. Your current text has been kept. Reconnect or reopen Folio using the app or CLI launch URL.",
      "error",
    );
    if (mode === "pop") restoreCommittedUrl();
    return false;
  }
  invalidatePreview();
  const loading = documentSession.beginLoad(mode);
  const controller = loading.controller;
  const root = appState.currentRoot;
  const known = resourceState.resourceIndex.get(path)?.path ?? (isResourceId(path) ? null : path);
  const label = known ? `“${known}”` : "the note";
  notice(
    appState.ui.loadingMessage,
    `${reload ? "Reloading" : "Opening"} ${label}…${documentSession.current ? " You can keep typing to cancel." : ""}`,
  );
  if (documentSession.current) previewStatus("Waiting for the requested note…");
  refreshControls();
  try {
    const resource = await documentResource(path, controller.signal);
    if (!documentSession.isCurrentLoad(loading)) return false;
    if (authenticationSession.mode === "users" && resource.project !== projectModel.active?.id) {
      targetUrl = makeNoteUrl(targetUrl, resource.id, hash);
      targetUrl.searchParams.set("project", resource.project);
      await loadProjects();
      if (!documentSession.isCurrentLoad(loading)) return false;
      return switchProject(resource.project, { url: targetUrl, mode });
    }
    targetUrl = makeNoteUrl(targetUrl, resource.id, hash);
    const prefetched = reload ? null : await prefetchedDocument(resource.id, controller.signal);
    const payload = expectDocument(
      prefetched ??
        (await api(documentReadUrl(resource.id), {
          decode: decodedDocument,
          signal: controller.signal,
        })),
    );
    if (!documentSession.isCurrentLoad(loading)) return false;
    if (root !== appState.currentRoot)
      throw new ApiError("The notes folder changed while this file was opening. Try opening it again.");
    useDocument(payload, root, targetUrl, mode);
    return true;
  } catch (errorCause) {
    const error = errorContext(errorCause);
    if (!documentSession.isCurrentLoad(loading) || aborted(error)) return false;
    documentNotice(
      `Could not ${reload ? "reload" : "open"} ${label}: ${error.message} Your current editor text has been kept.`,
      "error",
    );
    connectionFailure(error);
    if (mode === "pop") restoreCommittedUrl();
    if (documentSession.current) schedulePreview(0);
    return false;
  } finally {
    if (documentSession.finishLoad(loading)) {
      notice(appState.ui.loadingMessage, "");
      refreshControls();
      if (documentSession.current && dirty()) scheduleAutoSave();
    }
  }
}
export function captureViewPosition(view: string | undefined) {
  if (!documentSession.current) return null;
  if (documentState.pendingViewPosition?.document === documentSession.id)
    return { from: documentState.pendingViewPosition.from, to: documentState.pendingViewPosition.to };
  if (view === "rich") return appState.inlineEditor.getSelection({ navigation: true });
  if (view !== "preview") return appState.ui.editor.getSelection();
  const top = appState.ui.preview.getBoundingClientRect().top + 28;
  let marker = appState.ui.preview.querySelector<HTMLElement>("[data-source-offset]");
  for (const candidate of appState.ui.preview.querySelectorAll<HTMLElement>("[data-source-offset]")) {
    if (candidate.getBoundingClientRect().top > top) break;
    marker = candidate;
  }
  const from = Number(marker?.dataset.sourceOffset ?? 0);
  return { from, to: from };
}
export function restoreViewPosition() {
  const position = documentState.pendingViewPosition;
  if (!position || position.document !== documentSession.id) return false;
  const mode = shell.view;
  if (mode === "rich") {
    if (!appState.inlineEditor.isReady()) return false;
    appState.inlineEditor.select(position.from, position.to, true, position.focus);
  } else if (mode === "preview") {
    if (
      appState.renderedPreviewDocument !== documentSession.id ||
      appState.renderedPreviewRevision !== documentSession.revision
    )
      return false;
    const markers = [...appState.ui.preview.querySelectorAll<HTMLElement>("[data-source-offset]")];
    const marker = markers.findLast((node) => Number(node.dataset.sourceOffset) <= position.from) ?? markers[0];
    if (marker)
      appState.ui.preview.scrollTop +=
        marker.getBoundingClientRect().top - appState.ui.preview.getBoundingClientRect().top - 24;
    if (position.focus) appState.ui.preview.focus({ preventScroll: true });
  } else {
    appState.ui.editor.revealSelection(position.from, position.to, { focus: position.focus });
  }
  documentState.pendingViewPosition = null;
  return true;
}
