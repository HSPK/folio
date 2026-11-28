import { element } from "../../types/elements";
import { loadProjectCatalog as loadProjects } from "../projects/gateway";
import { projectModel } from "../../state/projects";
import { activePanelPath, libraryCatalog } from "../../state/library";
import { workspaceModel } from "../../state/workspace";
import { authenticationSession } from "../../state/authentication";
import { documentSession } from "../../state/document";
import { decodedDocument } from "../../api/contracts";
import {
  compactPageUrl,
  expandedPageUrl,
  createDocumentModel,
  isResourceId,
  makeNoteUrl,
  noteDisplayTitle,
  shareIdFromUrl,
  shortShareId,
  isShareId,
} from "@folio/model";
import { shell } from "../../state/shell";
import type { DocumentPayload, RouteMode, ViewPosition } from "../../types/domain";
import { errorContext } from "../../types/errors";
import {
  connectionFailure,
  expectDocument,
  refreshControls,
  restoreSidebar,
  setSidebar,
} from "../accounts/authentication";
import { stopCollaboration } from "../collaboration/collaboration";
import { startDocumentParticipation, stopDocumentParticipation } from "../collaboration/participation";
import { renderCollaborators } from "../collaboration/presence";
import { api } from "../core/api";
import { appState, dirty, rootChanged } from "../core/bootstrap";
import { ApiError, aborted, documentNotice, notice, previewStatus } from "../core/dom";
import { updateFileSelection } from "../navigation/library";
import { leaveFilePanel } from "../navigation/panels";
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
  const url = compactPageUrl(appState.committedUrl);
  if (window.location.href !== url.href) {
    window.history.replaceState(window.history.state, "", url);
  }
}
export function commitUrl(url: URL, mode = "push"): void {
  const target = compactPageUrl(url);
  if (mode === "push" && target.href !== compactPageUrl(appState.committedUrl).href)
    window.history.pushState(null, "", target);
  else if (window.location.href !== target.href) window.history.replaceState(window.history.state, "", target);
  appState.committedUrl = expandedPageUrl(url).href;
}
export function cancelDocumentLoad(restoreRoute = true) {
  const previous = documentSession.cancelLoad();
  if (!previous) return false;
  notice(element("loading-message"), "");
  if (restoreRoute && previous.mode === "pop") restoreCommittedUrl();
  refreshControls();
  if (documentSession.current) schedulePreview(0);
  return true;
}
export async function confirmDiscard(action: string) {
  return prepareDocumentLeave(action, "discard");
}
export function internalNoteUrl(url: URL) {
  if (url.origin !== window.location.origin) return false;
  if (publicState.publicView) {
    const id = shareIdFromUrl(url);
    return (
      !!id && isShareId(id) && !!publicState.publicToken && shortShareId(id) === shortShareId(publicState.publicToken)
    );
  }
  const route = expandedPageUrl(url);
  return (
    (route.pathname === "/" || route.pathname === "/index.html") && isResourceId(route.searchParams.get("document"))
  );
}
export function useDocument(
  payload: DocumentPayload,
  root: string | null,
  url: URL,
  mode: RouteMode,
  provisional = false,
): void {
  const initial = !documentSession.current && mode === "replace";
  cancelDocumentTransition();
  const nextDocument = { ...createDocumentModel(payload), root };
  const permissions = payload.permissions ? validatedDocumentPermissions(payload.permissions) : null;
  commitUrl(makeNoteUrl(url, provisional ? null : payload.id, url.hash), mode);
  stopDocumentParticipation();
  stopCollaboration();
  cancelAutoSave();
  invalidatePreview();
  appState.pendingHeading = null;
  documentSession.open(nextDocument);
  notice(element("loading-message"), "");
  resourceState.documentPermissions = permissions;
  // Scroll the tree before replacing editor content, avoiding a forced large-document layout.
  updateFileSelection(true);
  appState.inlineEditorPath = null;
  appState.editor.reset(nextDocument.text);
  if (!provisional) void startDocumentParticipation();
  renderCollaborators();
  if (["editor", "split"].includes(shell.view)) appState.editor.prepare();
  notice(element("rich-warning"), "");
  loadInlineEditorAfterPaint();
  notice(element("conflict-message"), "");
  documentNotice("");
  renderPreview(payload.html, true);
  previewStatus("Up to date");
  refreshControls();
  if (!provisional) noteVisited();
  if (initial) restoreSidebar(document.body.dataset.sidebar === "open");
  else if (appState.compactLayout.matches && mode !== "replace") setSidebar(false, true);
  const id = documentSession.id;
  window.requestAnimationFrame(() => {
    if (id !== documentSession.id) return;
    appState.editor.scrollTop = 0;
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
  notice(element("loading-message"), "");
  resourceState.documentPermissions = null;
  previewState.deferredPreview = null;
  appState.renderedPreviewDocument = null;
  appState.renderedPreviewRevision = -1;
  appState.editor.reset("");
  appState.inlineEditorPath = null;
  appState.inlineEditor.clear();
  notice(element("rich-warning"), "");
  notice(element("conflict-message"), "");
  documentNotice("");
  emptyPreview("A place for your Markdown", "Open or create a note");
  previewStatus("Select a note");
  commitUrl(url, mode);
  refreshControls();
  updateFileSelection();
}
export type InitialDocumentRead = { id: string; url: string; result: Promise<DocumentPayload> };
export async function navigateTo(
  path: string | null,
  hash = "",
  {
    mode = "push",
    url,
    reload = false,
    initialRead,
  }: {
    mode?: RouteMode;
    url?: URL | null;
    reload?: boolean;
    initialRead?: InitialDocumentRead;
  } = {},
) {
  if (activePanelPath() && !(await leaveFilePanel())) {
    if (mode === "pop") restoreCommittedUrl();
    return false;
  }
  let targetUrl = expandedPageUrl(url ?? appState.committedUrl);
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
    targetUrl = makeNoteUrl(targetUrl, documentSession.resourceId, hash);
    commitUrl(targetUrl, mode);
    scrollToHeading(hash);
    return true;
  }
  if (appState.creating) {
    documentNotice("Creation in progress");
    if (mode === "pop") restoreCommittedUrl();
    return false;
  }
  const action = reload ? "reload this note from disk" : path ? "open another note" : "close this note";
  if (!(reload ? await confirmDiscard(action) : await saveBeforeLeaving(action))) {
    if (mode === "pop") restoreCommittedUrl();
    return false;
  }
  if (leavingProjects) closeProjectManager();
  if (element("new-note-dialog").open) element("new-note-dialog").close();
  if (!path) {
    clearDocument(makeNoteUrl(targetUrl, null), mode);
    return true;
  }
  if (appState.connectionState !== "ready") {
    if (mode === "pop") restoreCommittedUrl();
    return false;
  }
  invalidatePreview();
  const loading = documentSession.beginLoad(mode);
  const controller = loading.controller;
  const root = appState.currentRoot;
  const known = resourceState.resourceIndex.get(path)?.path ?? (isResourceId(path) ? null : path);
  const file = libraryCatalog.files.find((f) => f.id === path || f.path === known);
  const recent =
    !publicState.publicView &&
    workspaceModel.lists.recent.find((n) => n.id === path && n.project === projectModel.active?.id);
  const target =
    documentSession.current?.id === path ? documentSession.current : file || recent || (known ? { path: known } : null);
  const label = target ? `“${noteDisplayTitle(target)}”` : "the note";
  notice(element("loading-message"), `${reload ? "Reloading" : "Opening"} ${label}…`);
  if (documentSession.current) previewStatus("Opening…");
  refreshControls();
  try {
    const resource =
      initialRead?.id === path && authenticationSession.mode === "launchToken"
        ? { id: path, project: "local" }
        : await documentResource(path, controller.signal);
    if (!documentSession.isCurrentLoad(loading)) return false;
    if (authenticationSession.mode === "users" && resource.project !== projectModel.active?.id) {
      targetUrl = makeNoteUrl(targetUrl, resource.id, hash);
      targetUrl.searchParams.set("project", resource.project);
      await loadProjects();
      if (!documentSession.isCurrentLoad(loading)) return false;
      return switchProject(resource.project, { url: targetUrl, mode });
    }
    if (projectModel.active) targetUrl.searchParams.set("project", projectModel.active.id);
    targetUrl = makeNoteUrl(targetUrl, resource.id, hash);
    const prefetched =
      initialRead?.id === resource.id && initialRead.url === documentReadUrl(resource.id)
        ? await initialRead.result
        : reload
          ? null
          : await prefetchedDocument(resource.id, controller.signal);
    const payload = expectDocument(
      prefetched ??
        (await api(documentReadUrl(resource.id), {
          decode: decodedDocument,
          signal: controller.signal,
        })),
    );
    if (!documentSession.isCurrentLoad(loading)) return false;
    if (payload.id !== resource.id || (projectModel.active && payload.project !== projectModel.active.id))
      throw new ApiError("Unexpected note in response");
    if (root !== appState.currentRoot) throw new ApiError("Notes folder changed");
    useDocument(payload, root, targetUrl, mode);
    return true;
  } catch (errorCause) {
    const error = errorContext(errorCause);
    if (!documentSession.isCurrentLoad(loading) || aborted(error)) return false;
    if (!isConnectionLoss(error)) documentNotice(`${reload ? "Reload" : "Open"} failed: ${error.message}`, "error");
    connectionFailure(error);
    if (mode === "pop") restoreCommittedUrl();
    if (documentSession.current) schedulePreview(0);
    return false;
  } finally {
    if (documentSession.finishLoad(loading)) {
      notice(element("loading-message"), "");
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
  if (view !== "preview") return appState.editor.getSelection();
  const top = element("preview").getBoundingClientRect().top + 28;
  let marker = element("preview").querySelector<HTMLElement>("[data-source-offset]");
  for (const candidate of element("preview").querySelectorAll<HTMLElement>("[data-source-offset]")) {
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
    const markers = [...element("preview").querySelectorAll<HTMLElement>("[data-source-offset]")];
    const marker = markers.findLast((node) => Number(node.dataset.sourceOffset) <= position.from) ?? markers[0];
    if (marker)
      element("preview").scrollTop +=
        marker.getBoundingClientRect().top - element("preview").getBoundingClientRect().top - 24;
    if (position.focus) element("preview").focus({ preventScroll: true });
  } else {
    appState.editor.revealSelection(position.from, position.to, { focus: position.focus });
  }
  documentState.pendingViewPosition = null;
  return true;
}
import { isConnectionLoss } from "../core/recovery";
