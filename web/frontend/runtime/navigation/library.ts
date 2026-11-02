import { documentSession } from "../../state/document";
import { filterNotes, sameTreeEntries } from "@folio/model";
import { decodedTree } from "../../api/contracts";
import { libraryCatalog, libraryModel } from "../../state/library";
import { clearTimer } from "../../types/elements";
import { errorContext } from "../../types/errors";
import { connectionFailure, refreshControls, setRoot } from "../accounts/authentication";
import { api } from "../core/api";
import { appState, rootChanged } from "../core/bootstrap";
import { aborted, notice } from "../core/dom";
import { resourceState } from "../documents/resources";
import { onApplicationDispose } from "../lifecycle";
import { settingsState, visibleLibraryDirectories, visibleLibraryFiles } from "../preferences/settings";
import { syncTreeTabStop } from "./tree";

class LibraryState {
  fileFilterFrame: number | null = null;
  selectedFileButton: HTMLButtonElement | null = null;
  treeRefreshTimer: number | null = null;
  treeTabStop: HTMLElement | null = null;
  readonly TREE_ITEMS = ".file-button, .directory > summary";
}
export const libraryState = new LibraryState();

export function initializeNavigationLibrary(): void {
  libraryState.fileFilterFrame = libraryState.treeRefreshTimer = null;
  libraryState.selectedFileButton = libraryState.treeTabStop = null;
  onApplicationDispose(() => {
    clearTimer(libraryState.treeRefreshTimer);
    if (libraryState.fileFilterFrame !== null) cancelAnimationFrame(libraryState.fileFilterFrame);
    libraryState.selectedFileButton = libraryState.treeTabStop = null;
  });
}

export function refreshFilteredNote(): void {
  libraryModel.select(rootChanged() ? null : documentSession.current);
}

export function scheduleTreeRefresh(): void {
  clearTimer(libraryState.treeRefreshTimer);
  libraryState.treeRefreshTimer = null;
  if (
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

export function renderTreeStatus(
  libraryFiles = visibleLibraryFiles(),
  visible = filterNotes(libraryFiles, appState.ui.filter.value),
): void {
  let message = libraryCatalog.error;
  if (libraryCatalog.loading) message = libraryCatalog.loaded ? "Refreshing the file list…" : "Loading Markdown files…";
  else if (!message && libraryCatalog.loaded && !libraryFiles.length) message = "No notes yet.";
  else if (!message && libraryCatalog.loaded && !visible.length) message = "No notes match your filter.";
  else if (!message && !libraryCatalog.loaded)
    message =
      appState.connectionState === "ready"
        ? "Refresh to list Markdown files."
        : "Open Folio using the app or CLI launch URL to connect.";
  notice(appState.ui.treeMessage, message, libraryCatalog.error && !libraryCatalog.loading ? "error" : "");
  notice(
    appState.ui.treeLimit,
    libraryCatalog.truncated ? "File limit reached. Filtering searches only the listed notes." : "",
    "warning",
  );
  appState.ui.fileNav.setAttribute("aria-busy", String(libraryCatalog.loading));
}

/** Publish a keyed presentation; Solid exclusively creates, updates and removes tree rows. */
export function renderFiles(): void {
  if (libraryState.fileFilterFrame !== null) {
    cancelAnimationFrame(libraryState.fileFilterFrame);
    libraryState.fileFilterFrame = null;
  }
  libraryModel.project(visibleLibraryFiles(), visibleLibraryDirectories(), appState.ui.filter.value);
  updateFileSelection();
  renderTreeStatus();
}

export function updateFileSelection(): void {
  refreshFilteredNote();
  const next = appState.ui.fileList.querySelector<HTMLButtonElement>('[aria-current="page"]');
  const unchanged = libraryState.selectedFileButton === next;
  libraryState.selectedFileButton = next;
  if (!next) {
    syncTreeTabStop();
    return;
  }
  revealFileButton(next);
  syncTreeTabStop();
  if (!unchanged) next.scrollIntoView({ block: "nearest" });
}

export function revealFileButton(button: HTMLButtonElement): void {
  let parent = button.parentElement;
  while (parent && parent !== appState.ui.fileList) {
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
  updateFileSelection();
}

export async function refreshFiles(): Promise<void> {
  resourceState.unavailableResourceLinks.clear();
  clearTimer(libraryState.treeRefreshTimer);
  libraryState.treeRefreshTimer = null;
  if (appState.connectionState !== "ready") return;
  appState.treeController?.abort();
  const controller = new AbortController();
  appState.treeController = controller;
  const ticket = appState.treeGate.next();
  libraryModel.update({ loading: true });
  refreshControls();
  renderTreeStatus();
  try {
    const result = await api("/api/tree", { signal: controller.signal, decode: decodedTree });
    if (!appState.treeGate.isCurrent(ticket)) return;
    setRoot(result.root);
    const changed =
      !sameTreeEntries(libraryCatalog.files, result.files) ||
      !sameTreeEntries(libraryCatalog.directories, result.directories);
    libraryModel.replace(result.files, result.directories, result.truncated);
    if (changed) {
      renderFiles();
      updateFileSelection();
    }
  } catch (cause) {
    const error = errorContext(cause);
    if (!appState.treeGate.isCurrent(ticket) || aborted(error)) return;
    libraryModel.update({
      error: `Could not refresh files: ${error.message}${libraryCatalog.loaded ? " The previous list is still shown." : ""}`,
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
