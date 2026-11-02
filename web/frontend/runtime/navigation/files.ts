import { authenticationSession } from "../../state/authentication";
import { documentSession } from "../../state/document";
import { libraryModel } from "../../state/library";
import { decodedDirectory, decodedDocument, decodedEntry, decodedMove } from "../../api/contracts";
import {
  entryDestination,
  formatByteCount,
  isResourceId,
  makeNoteUrl,
  validateNewDirectoryPath,
  validateNewNotePath,
} from "@folio/model";
import { notePathFromTitle, templateContent, templateTitle } from "@folio/workspace-model";
import { isDocumentView, shell, updateShell } from "../../state/shell";
import { clearTimer, htmlChildren, requireValue } from "../../types/elements";
import { errorContext } from "../../types/errors";
import { closeMenus, connectionFailure, expectDocument, refreshControls } from "../accounts/authentication";
import { publishCollaborativeCursor, schedulePeerCursors } from "../collaboration/presence";
import { api } from "../core/api";
import { appState, dirty, rootChanged } from "../core/bootstrap";
import { ApiError, documentNotice, notice, setText } from "../core/dom";
import { showDialog } from "../dialogs/dialogs";
import { loadInlineEditor } from "../documents/live";
import {
  cancelDocumentLoad,
  captureViewPosition,
  documentState,
  navigateTo,
  restoreViewPosition,
  useDocument,
} from "../documents/navigation";
import { invalidatePreview, schedulePreview } from "../documents/preview";
import { currentResourceId } from "../documents/resources";
import { saveBeforeLeaving } from "../documents/saving";
import { listen } from "../lifecycle";
import { projectCanCreate } from "../projects/permissions";
import { loadUserWorkspace } from "../workspace/workspace";
import { refreshFiles } from "./library";
class FileState {
  suggestedNoteTitle!: string;
  fileMenuReturnFocus!: HTMLElement | null;
}
export const fileState = new FileState();
export function initializeNavigationFiles(): void {
  fileState.suggestedNoteTitle = "";
  listen(appState.element("new-note-template"), "change", () => {
    const title = templateTitle(appState.element("new-note-template").value);
    if (!appState.ui.newTitle.value.trim() || appState.ui.newTitle.value === fileState.suggestedNoteTitle)
      appState.ui.newTitle.value = title;
    fileState.suggestedNoteTitle = title;
    appState.ui.newTitle.setAttribute("aria-invalid", "false");
    refreshNewNoteHint();
  });
  fileState.fileMenuReturnFocus = null;
}
export function refreshNewNoteHint(): void {
  try {
    setText(appState.ui.newNoteHint, `File: ${notePathFromTitle(appState.ui.newTitle.value, appState.newItemParent)}`);
  } catch (errorCause) {
    const error = errorContext(errorCause);
    setText(appState.ui.newNoteHint, error.message);
  }
}
export async function openNewNote(parentPath: string | null = null) {
  if (!projectCanCreate()) return;
  if (appState.connectionState !== "ready" || appState.creating || appState.movingEntry) return;
  cancelDocumentLoad();
  if (!(await saveBeforeLeaving("create a new note"))) return;
  appState.newNoteOrigin = { id: documentSession.id, revision: documentSession.revision, root: appState.currentRoot };
  const parent =
    typeof parentPath === "string"
      ? parentPath
      : documentSession.current && !rootChanged() && documentSession.current.path.includes("/")
        ? documentSession.current.path.slice(0, documentSession.current.path.lastIndexOf("/"))
        : "";
  appState.newItemParent = parent;
  appState.element("new-note-template").value = "blank";
  fileState.suggestedNoteTitle = templateTitle("blank");
  appState.ui.newTitle.value = fileState.suggestedNoteTitle;
  appState.ui.newTitle.setAttribute("aria-invalid", "false");
  refreshNewNoteHint();
  notice(appState.ui.newError, "");
  showDialog(appState.ui.newDialog);
  appState.ui.newTitle.focus();
  appState.ui.newTitle.select();
  return true;
}
export async function createNote(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (appState.creating) return;
  let path;
  let content;
  try {
    path = notePathFromTitle(appState.ui.newTitle.value, appState.newItemParent);
    content = templateContent(appState.element("new-note-template").value, appState.ui.newTitle.value);
  } catch (errorCause) {
    const error = errorContext(errorCause);
    notice(appState.ui.newError, error.message, "error");
    appState.ui.newTitle.setAttribute("aria-invalid", "true");
    appState.ui.newTitle.focus();
    return;
  }
  if (appState.connectionState !== "ready" || requireValue(appState.newNoteOrigin).root !== appState.currentRoot) {
    notice(
      appState.ui.newError,
      "The connection or notes folder changed. Cancel and reopen New note after reconnecting.",
      "error",
    );
    return;
  }
  if (
    (requireValue(appState.newNoteOrigin).id !== documentSession.id ||
      requireValue(appState.newNoteOrigin).revision !== documentSession.revision) &&
    !(await saveBeforeLeaving("create a new note"))
  )
    return;
  const origin = { id: documentSession.id, revision: documentSession.revision, root: appState.currentRoot };
  appState.creating = true;
  notice(appState.ui.newError, "");
  refreshControls();
  try {
    const payload = expectDocument(
      await api("/api/document", {
        decode: decodedDocument,
        method: "POST",
        body: { path, content },
      }),
    );
    appState.ui.newDialog.close();
    if (
      origin.id === documentSession.id &&
      origin.revision === documentSession.revision &&
      origin.root === appState.currentRoot
    ) {
      useDocument(payload, origin.root, makeNoteUrl(appState.committedUrl, payload.id), "push");
      if (shell.view === "preview") setView("rich");
      if (shell.view === "rich") appState.inlineEditor.focus();
      else appState.ui.editor.focus();
    } else {
      documentNotice(
        `Created “${payload.path}”. Your current editor text was kept because the open note or folder changed.`,
        "warning",
      );
    }
    void refreshFiles();
  } catch (errorCause) {
    const error = errorContext(errorCause);
    const prefix = error.status === 409 ? "A note with this file name already exists. Choose a different title. " : "";
    notice(appState.ui.newError, `${prefix}${error.message} No existing note was replaced.`, "error");
    appState.ui.newTitle.setAttribute("aria-invalid", "true");
    connectionFailure(error);
  } finally {
    appState.creating = false;
    refreshControls();
  }
}
export function openNewFolder(parentPath = ""): void {
  if (!projectCanCreate()) return;
  if (appState.connectionState !== "ready" || appState.creating || appState.movingEntry) return;
  appState.newItemParent = typeof parentPath === "string" ? parentPath : "";
  const prefix = appState.newItemParent ? `${appState.newItemParent}/` : "";
  appState.ui.newFolderPath.value = `${prefix}New folder`;
  appState.ui.newFolderPath.setAttribute("aria-invalid", "false");
  notice(appState.ui.newFolderError, "");
  showDialog(appState.ui.newFolderDialog);
  appState.ui.newFolderPath.focus();
  appState.ui.newFolderPath.setSelectionRange(prefix.length, appState.ui.newFolderPath.value.length);
}
export async function createFolder(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (appState.creating) return;
  let path;
  try {
    path = validateNewDirectoryPath(appState.ui.newFolderPath.value);
  } catch (errorCause) {
    const error = errorContext(errorCause);
    notice(appState.ui.newFolderError, error.message, "error");
    appState.ui.newFolderPath.setAttribute("aria-invalid", "true");
    appState.ui.newFolderPath.focus();
    return;
  }
  appState.creating = true;
  notice(appState.ui.newFolderError, "");
  refreshControls();
  try {
    const result = await api("/api/directory", {
      decode: decodedDirectory,
      method: "POST",
      body: { path },
    });
    if (result?.path !== path) throw new ApiError("The service returned a different folder.");
    appState.ui.newFolderDialog.close();
    libraryModel.setCollapsed(appState.newItemParent, false);
    libraryModel.setCollapsed(path, false);
    documentNotice("");
    await refreshFiles();
  } catch (errorCause) {
    const error = errorContext(errorCause);
    notice(appState.ui.newFolderError, `${error.message} No existing file or folder was replaced.`, "error");
    appState.ui.newFolderPath.setAttribute("aria-invalid", "true");
    connectionFailure(error);
  } finally {
    appState.creating = false;
    refreshControls();
  }
}
export function closeFileContextMenu(restore = true): void {
  appState.ui.fileContextMenu.hidden = true;
  appState.contextFile = null;
  if (restore && fileState.fileMenuReturnFocus?.isConnected)
    fileState.fileMenuReturnFocus.focus({ preventScroll: true });
  fileState.fileMenuReturnFocus = null;
}
export function openFileContextMenu(event: MouseEvent, path: string, kind: "file" | "directory" = "file"): void {
  if (!(event.target instanceof Element)) return;
  event.preventDefault();
  closeMenus();
  appState.contextFile = { path, kind };
  fileState.fileMenuReturnFocus = event.target.closest<HTMLElement>("[data-entry-path]");
  appState.ui.fileRename.disabled = !projectCanCreate();
  appState.ui.fileDetails.hidden = kind !== "file";
  appState.element("file-context-name").textContent = path.split("/").at(-1) ?? path;
  const anchor = requireValue(fileState.fileMenuReturnFocus).getBoundingClientRect();
  const x = event.clientX || anchor.left + 12;
  const y = event.clientY || anchor.bottom;
  appState.ui.fileContextMenu.hidden = false;
  appState.ui.fileContextMenu.style.left = `${x}px`;
  appState.ui.fileContextMenu.style.top = `${y}px`;
  appState.ui.fileContextMenu
    .querySelector<HTMLButtonElement>("button:not([hidden]):not(:disabled)")
    ?.focus({ preventScroll: true });
  window.requestAnimationFrame(() => {
    if (appState.ui.fileContextMenu.hidden) return;
    const bounds = appState.ui.fileContextMenu.getBoundingClientRect();
    appState.ui.fileContextMenu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8))}px`;
    appState.ui.fileContextMenu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8))}px`;
  });
}
export async function showFileDetails(): Promise<void> {
  const selected = appState.contextFile;
  closeFileContextMenu();
  if (!selected) return;
  try {
    const details = await api(`/api/entry?id=${encodeURIComponent(currentResourceId(selected.path))}`, {
      decode: decodedEntry,
    });
    if (details.path !== selected.path) {
      throw new ApiError("The service returned incomplete file details.");
    }
    setText(appState.ui.detailsName, details.name);
    setText(appState.ui.detailsMetadataTitle, details.title || "—");
    setText(appState.ui.detailsPath, details.path);
    setText(appState.ui.detailsSize, formatByteCount(details.size));
    setText(
      appState.ui.detailsModified,
      details.modifiedUnixMs !== null ? new Date(details.modifiedUnixMs).toLocaleString() : "—",
    );
    showDialog(appState.ui.detailsDialog);
  } catch (errorCause) {
    const error = errorContext(errorCause);
    documentNotice(`Could not read file details: ${error.message}`, "error");
    connectionFailure(error);
  }
}
export function openRenameDialog(): void {
  const selected = appState.contextFile;
  closeFileContextMenu();
  if (!selected) return;
  appState.contextFile = selected;
  const name = requireValue(selected.path.split("/").at(-1), "File name");
  appState.ui.renamePath.value = name;
  setText(appState.element("rename-title"), selected.kind === "file" ? "Rename file" : "Rename folder");
  setText(
    appState.element("rename-hint"),
    selected.kind === "file"
      ? "This changes the file name, not the display title. Edit the title in Properties."
      : "This changes the folder name and keeps its contents.",
  );
  appState.ui.confirmRename.disabled = true;
  appState.element("rename-update-links").checked = true;
  appState.ui.renamePath.setAttribute("aria-invalid", "false");
  notice(appState.ui.renameError, "");
  showDialog(appState.ui.renameDialog);
  appState.ui.renamePath.focus();
  const extension = selected.kind === "file" ? requireValue(name).lastIndexOf(".") : -1;
  appState.ui.renamePath.setSelectionRange(0, extension > 0 ? extension : requireValue(name).length);
}
export function renameChanged() {
  return Boolean(
    appState.contextFile &&
    appState.ui.renamePath.value.trim() &&
    appState.ui.renamePath.value.trim() !== appState.contextFile.path.split("/").at(-1),
  );
}
export async function renameEntry(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (!appState.contextFile || appState.movingEntry) return;
  if (!renameChanged()) return;
  const name = appState.ui.renamePath.value.trim();
  if (!name || name.includes("/") || name.includes("\\")) {
    notice(appState.ui.renameError, "Enter one file or folder name without slashes.", "error");
    appState.ui.renamePath.setAttribute("aria-invalid", "true");
    return;
  }
  const parent = appState.contextFile.path.includes("/")
    ? appState.contextFile.path.slice(0, appState.contextFile.path.lastIndexOf("/"))
    : "";
  const destination = entryDestination(appState.contextFile.path, parent, name);
  try {
    if (appState.contextFile.kind === "file") validateNewNotePath(destination);
    else validateNewDirectoryPath(destination);
  } catch (errorCause) {
    const error = errorContext(errorCause);
    notice(appState.ui.renameError, error.message, "error");
    appState.ui.renamePath.setAttribute("aria-invalid", "true");
    return;
  }
  if (await moveLibraryEntry(appState.contextFile, destination, appState.element("rename-update-links").checked)) {
    appState.ui.renameDialog.close();
    appState.contextFile = null;
  }
}
export async function moveLibraryEntry(
  entry: {
    path: string;
    kind: "file" | "directory";
  },
  destination: unknown,
  updateLinks = true,
) {
  if (appState.movingEntry || entry.path === destination) return false;
  const activePath = documentSession.current?.path;
  const affectsActive =
    activePath === entry.path || (entry.kind === "directory" && activePath?.startsWith(`${entry.path}/`));
  if (affectsActive && dirty()) {
    documentNotice("Save or discard the open note before moving or renaming it.", "warning");
    return false;
  }
  appState.movingEntry = true;
  refreshControls();
  try {
    const result = await api("/api/entry", {
      decode: decodedMove,
      method: "PATCH",
      body: {
        id: currentResourceId(entry.path, entry.kind === "directory" ? "directory" : "document"),
        destination,
        updateLinks,
      },
    });
    if (!result || typeof result.path !== "string" || result.kind !== entry.kind || !isResourceId(result.id)) {
      throw new ApiError("The service returned an incomplete move result.");
    }
    await refreshFiles();
    destination = result.path;
    if (authenticationSession.mode === "users") void loadUserWorkspace();
    if (activePath === entry.path && result.document) {
      useDocument(
        expectDocument(result.document),
        appState.currentRoot,
        makeNoteUrl(appState.committedUrl, result.document.id),
        "replace",
      );
    } else if (affectsActive) {
      const nextPath = `${destination}${requireValue(activePath).slice(entry.path.length)}`;
      await navigateTo(nextPath, "", { mode: "replace", reload: true });
    }
    documentNotice(result.warning ?? "", result.warning ? "warning" : "");
    return true;
  } catch (errorCause) {
    const error = errorContext(errorCause);
    const message = `Could not move “${entry.path}”: ${error.message}`;
    if (appState.ui.renameDialog.open) notice(appState.ui.renameError, message, "error");
    else documentNotice(message, "error");
    connectionFailure(error);
    return false;
  } finally {
    appState.movingEntry = false;
    refreshControls();
  }
}
export function setDropTarget(target: HTMLElement | null): void {
  if (appState.dropTarget === target) return;
  if (appState.dropTarget) appState.dropTarget.removeAttribute("data-drop-target");
  appState.dropTarget = target;
  if (appState.dropTarget) appState.dropTarget.setAttribute("data-drop-target", "true");
}
export function setView(view: unknown, focus = false): void {
  if (!isDocumentView(view)) throw new Error(`Unknown document view: ${view}`);
  const previousView = shell.view;
  if (view !== previousView) {
    const selection = captureViewPosition(previousView);
    documentState.pendingViewPosition = selection ? { ...selection, document: documentSession.id, focus } : null;
  }
  if (["editor", "split"].includes(view)) appState.ui.editor.prepare();
  updateShell({ view });
  const visiblePanes = new Set(
    view === "split" ? ["editor-pane", "preview-pane"] : [`${view === "rich" ? "rich" : view}-pane`],
  );
  for (const pane of htmlChildren(appState.ui.panes)) {
    const visible = [...visiblePanes].some((className) => pane.classList.contains(className));
    pane.inert = !visible;
    pane.setAttribute("aria-hidden", String(!visible));
  }
  if (view !== previousView) {
    appState.inlineEditor.dismissMenus();
    if (view === "rich") notice(appState.element("rich-warning"), "");
    appState.focusAfterLoad = view === "rich" && focus;
    loadInlineEditor();
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>(".view-options button")) {
    button.setAttribute("aria-pressed", String(button.dataset.view === view));
  }
  publishCollaborativeCursor();
  schedulePeerCursors();
  if (["split", "preview"].includes(view)) schedulePreview(0);
  else invalidatePreview();
  const restored = restoreViewPosition();
  if (focus && !restored && !documentState.pendingViewPosition) {
    if (view === "preview") appState.ui.preview.focus();
    else if (view === "rich") appState.inlineEditor.focus();
    else if (documentSession.current) appState.ui.editor.focus({ preventScroll: true });
  }
}
export async function copyText(): Promise<void> {
  if (!documentSession.current) return;
  const text = appState.ui.editor.value;
  const id = documentSession.id;
  clearTimer(appState.copyTimer);
  try {
    await navigator.clipboard.writeText(text);
    setText(appState.ui.copy, "Copied");
    setText(appState.ui.copyStatus, "Editor text copied to the clipboard.");
  } catch {
    if (id === documentSession.id) {
      setView("editor");
      appState.ui.editor.focus();
      appState.ui.editor.select();
      setText(appState.ui.copy, "Press Ctrl+C");
      setText(appState.ui.copyStatus, "Clipboard access is unavailable. Editor text selected; press Ctrl+C to copy.");
      documentNotice("Clipboard access is unavailable. Your text is selected in the editor; press Ctrl+C to copy it.");
    }
  }
  appState.copyTimer = window.setTimeout(() => setText(appState.ui.copy, "Copy Markdown"), 3000);
}
