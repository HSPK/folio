import { authenticationSession } from "../../state/authentication";
import { documentSession } from "../../state/document";
import { projectModel } from "../../state/projects";
import { sameTreeEntries } from "@folio/model";
import { notModified } from "../../api/client";
import { decodedTree } from "../../api/contracts";
import { libraryCatalog, libraryModel } from "../../state/library";
import { element, clearTimer } from "../../types/elements";
import { errorContext } from "../../types/errors";
import { connectionFailure, refreshControls, setRoot } from "../accounts/authentication";
import { api } from "../core/api";
import { appState, rootChanged } from "../core/bootstrap";
import { aborted, notice } from "../core/dom";
import { readLayoutPreference, storeLayoutPreference } from "../core/layout";
import { resourceState } from "../documents/resources";
import { publicState } from "../sharing/public";
import { onApplicationDispose } from "../lifecycle";
import { settingsState, visibleLibraryDirectories, visibleLibraryFiles } from "../preferences/settings";
import { restoreEntryIcons } from "./icons";
import { restoreTreeOrder } from "./order";
import { syncTreeTabStop, treeItemVisible } from "./tree";

class LibraryState {
  fileFilterFrame: number | null = null;
  selectedFileButton: HTMLButtonElement | null = null;
  treeRefreshTimer: number | null = null;
  treeTabStop: HTMLElement | null = null;
  readonly TREE_ITEMS = ".file-button, .directory > summary";
}
export const libraryState = new LibraryState();
let validator: { scope: symbol; project: symbol; version: number; etag: string | null } | null = null;

export function initializeNavigationLibrary(): void {
  libraryState.fileFilterFrame = libraryState.treeRefreshTimer = null;
  libraryState.selectedFileButton = libraryState.treeTabStop = null;
  libraryModel.observeExpanded((paths) => storeLayoutPreference(expandedFoldersKey(), JSON.stringify([...paths])));
  onApplicationDispose(() => {
    validator = null;
    libraryModel.observeExpanded(null);
    clearTimer(libraryState.treeRefreshTimer);
    if (libraryState.fileFilterFrame !== null) cancelAnimationFrame(libraryState.fileFilterFrame);
    libraryState.selectedFileButton = libraryState.treeTabStop = null;
  });
}

/** Folder states belong to one account's view of one project, so a reload reopens the tree as it was left. */
function expandedFoldersKey() {
  const account = authenticationSession.user?.username ?? "local";
  return `folio.tree.expanded.${account}.${projectModel.active?.id ?? appState.currentRoot ?? "default"}`;
}

function restoreExpandedFolders(directories: readonly { path: string }[]): void {
  let stored: unknown = null;
  try {
    stored = JSON.parse(readLayoutPreference(expandedFoldersKey()) ?? "null");
  } catch {
    stored = null;
  }
  const known = new Set(directories.map((directory) => directory.path));
  libraryModel.restoreExpanded(
    Array.isArray(stored) ? stored.filter((path): path is string => typeof path === "string" && known.has(path)) : [],
  );
}

function refreshFilteredNote(): void {
  libraryModel.select(rootChanged() ? null : documentSession.current);
}

export function scheduleTreeRefresh(): void {
  clearTimer(libraryState.treeRefreshTimer);
  libraryState.treeRefreshTimer = null;
  if (
    publicState.publicView ||
    !settingsState.webPreferences.treeRefreshSeconds ||
    appState.connectionState !== "ready" ||
    document.visibilityState === "hidden"
  )
    return;
  libraryState.treeRefreshTimer = window.setTimeout(
    () => void refreshFiles(),
    settingsState.webPreferences.treeRefreshSeconds * 1000,
  );
}

export function scheduleFileFilterRender(): void {
  if (libraryState.fileFilterFrame !== null) return;
  libraryState.fileFilterFrame = requestAnimationFrame(() => {
    libraryState.fileFilterFrame = null;
    renderFiles();
  });
}

export function renderTreeStatus(): void {
  let message = libraryCatalog.error;
  if (libraryCatalog.loading) message = libraryCatalog.loaded ? "Refreshing…" : "Loading…";
  else if (!message && libraryCatalog.loaded && !libraryModel.visibleCount) message = "No notes yet";
  else if (!message && libraryCatalog.loaded && !libraryModel.matchingCount) message = "No matching notes";
  else if (!message && !libraryCatalog.loaded && projectModel.active && appState.connectionState === "connecting")
    message = "Loading…";
  else if (!message && !libraryCatalog.loaded)
    message = appState.connectionState === "ready" ? "Refresh to list files" : "";
  notice(element("tree-message"), message, libraryCatalog.error && !libraryCatalog.loading ? "error" : "");
  notice(element("tree-limit"), libraryCatalog.truncated ? "File limit reached" : "", "warning");
  element("file-nav").setAttribute("aria-busy", String(libraryCatalog.loading));
}

/** Publish a keyed presentation; Solid exclusively creates, updates and removes tree rows. */
export function renderFiles(): void {
  if (libraryState.fileFilterFrame !== null) {
    cancelAnimationFrame(libraryState.fileFilterFrame);
    libraryState.fileFilterFrame = null;
  }
  const files = visibleLibraryFiles();
  if (libraryCatalog.panelFiles.length)
    files.push(...libraryCatalog.panelFiles.filter((f) => !settingsState.hiddenPath(f.path)));
  libraryModel.project(files, visibleLibraryDirectories(), element("file-filter").value);
  updateFileSelection();
  renderTreeStatus();
}

export function updateFileSelection(reveal = false): void {
  refreshFilteredNote();
  const next = element("file-list").querySelector<HTMLButtonElement>('[aria-current="page"]');
  const unchanged = libraryState.selectedFileButton === next;
  libraryState.selectedFileButton = next;
  if (!next) {
    syncTreeTabStop();
    return;
  }
  if (reveal) revealFileButton(next);
  syncTreeTabStop();
  if (!unchanged && treeItemVisible(next)) next.scrollIntoView({ block: "nearest" });
}

function revealFileButton(button: HTMLButtonElement): void {
  let parent = button.parentElement;
  while (parent && parent !== element("file-list")) {
    if (parent instanceof HTMLDetailsElement && !parent.open) parent.open = true;
    parent = parent.parentElement;
  }
}

export function updateFileTitle(path: string, title: string | null | undefined): void {
  const file = libraryCatalog.files.find((file) => file.path === path);
  const next = title || null;
  if (!file || file.title === next) return;
  libraryModel.setTitle(path, next);
  renderFiles();
}

// Start a cold tree alongside the scoped session, without publishing rows until that session is ready.
export function prepareProjectTree(signal: AbortSignal) {
  const revalidate = { etag: null as string | null };
  const controller = new AbortController();
  const result = api("/api/tree", {
    signal: AbortSignal.any([signal, controller.signal]),
    revalidate,
    decode: decodedTree,
  });
  // Connection failure or a newer switch may discard this read without consuming it.
  void result.catch(() => {});
  return { result, revalidate, controller };
}

export async function refreshFiles(prepared?: ReturnType<typeof prepareProjectTree>): Promise<void> {
  if (publicState.publicView) return;
  resourceState.unavailableResourceLinks.clear();
  clearTimer(libraryState.treeRefreshTimer);
  libraryState.treeRefreshTimer = null;
  if (appState.connectionState !== "ready") return;
  appState.treeController?.abort();
  const controller = prepared?.controller ?? new AbortController();
  appState.treeController = controller;
  const ticket = appState.treeGate.next();
  const scope = authenticationSession.scope.key;
  const project = projectModel.selection;
  const revalidate = prepared?.revalidate ?? {
    etag:
      validator?.scope === scope && validator.project === project && validator.version === libraryModel.version
        ? validator.etag
        : null,
  };
  libraryModel.update({ loading: true });
  refreshControls();
  renderTreeStatus();
  try {
    const result = await (prepared?.result ??
      api("/api/tree", {
        signal: controller.signal,
        revalidate,
        decode: (value) => (value === notModified ? null : decodedTree(value)),
      }));
    if (
      !appState.treeGate.isCurrent(ticket) ||
      scope !== authenticationSession.scope.key ||
      project !== projectModel.selection
    )
      return;
    if (!result) {
      libraryModel.update({ error: "" });
      return;
    }
    if (appState.currentRoot !== result.root) setRoot(result.root);
    const first = !libraryCatalog.loaded;
    const changed =
      first ||
      !sameTreeEntries(libraryCatalog.panelFiles, result.panelFiles) ||
      !sameTreeEntries(libraryCatalog.files, result.files) ||
      !sameTreeEntries(libraryCatalog.directories, result.directories);
    if (changed) libraryModel.replace(result.files, result.directories, result.truncated, result.panelFiles);
    else libraryModel.update({ error: "", truncated: result.truncated });
    validator = { scope, project, version: libraryModel.version, etag: revalidate.etag };
    if (first) {
      restoreExpandedFolders(result.directories);
      restoreEntryIcons();
      restoreTreeOrder();
    }
    if (changed) renderFiles();
  } catch (cause) {
    const error = errorContext(cause);
    if (!appState.treeGate.isCurrent(ticket) || aborted(error)) return;
    if (error.status === 401 || error.status === 403) {
      libraryModel.reset(true);
      renderFiles();
    }
    libraryModel.update({
      error: isConnectionLoss(error) ? "" : `Refresh failed: ${error.message}`,
    });
    connectionFailure(error);
  } finally {
    if (appState.treeGate.isCurrent(ticket)) {
      libraryModel.update({ loading: false });
      appState.treeController = null;
      renderTreeStatus();
      refreshControls();
      scheduleTreeRefresh();
    }
  }
}
import { isConnectionLoss } from "../core/recovery";
