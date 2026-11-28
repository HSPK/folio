import { authenticationSession } from "../../state/authentication";
import { documentSession } from "../../state/document";
import { libraryCatalog, libraryModel, libraryView } from "../../state/library";
import { projectModel } from "../../state/projects";
import { decodedEntry, decodedMove } from "../../api/contracts";
import {
  entryDestination,
  formatByteCount,
  isResourceId,
  noteName,
  validateNewDirectoryPath,
  validateNewNotePath,
} from "@folio/model";
import { notePathFromTitle, templateContent, templateTitle } from "@folio/workspace-model";
import { isDocumentView, shell, updateShell } from "../../state/shell";
import { element, clearTimer, htmlChildren, requireValue } from "../../types/elements";
import { errorContext } from "../../types/errors";
import { closeMenus, connectionFailure, expectDocument, refreshControls, setSidebar } from "../accounts/authentication";
import { publishCollaborativeCursor, schedulePeerCursors } from "../collaboration/presence";
import { collaboration } from "../collaboration/collaboration";
import { api } from "../core/api";
import { appState, dirty, rootChanged } from "../core/bootstrap";
import { ApiError, documentNotice, notice, setText } from "../core/dom";
import { showDialog } from "../dialogs/dialogs";
import { loadInlineEditor } from "../documents/live";
import {
  cancelDocumentLoad,
  captureViewPosition,
  documentState,
  restoreViewPosition,
  useDocument,
} from "../documents/navigation";
import { invalidatePreview, schedulePreview } from "../documents/preview";
import { currentResourceId, entryResourceId } from "../documents/resources";
import { saveBeforeLeaving, scheduleAutoSave } from "../documents/saving";
import { listen } from "../lifecycle";
import { projectCanCreate, projectCanMove, projectOwns, projectWritable } from "../projects/permissions";
import { loadUserWorkspace } from "../workspace/workspace";
import { initializeEntryIcons, relocateEntryIcons } from "./icons";
import { initializeFileActions } from "./file-actions";
import { loadFileProperties } from "./file-properties";
import { activePanelPath } from "../../state/library";
import { leaveFilePanel, openFilePanel } from "./panels";
import { publicState } from "../sharing/public";
import { workspaceModel } from "../../state/workspace";
import { refreshFiles, renderFiles } from "./library";
import { createTemplateFile, nameTaken, waitForConnection } from "./creation";
let suggestedNoteTitle: string;
let fileMenuReturnFocus: HTMLElement | null;
export let addParent: string | null = null;

export function initializeNavigationFiles(): void {
  suggestedNoteTitle = "";
  initializeEntryIcons(() => closeFileContextMenu());
  initializeFileActions();
  listen(element("new-note-template"), "change", () => {
    const title = templateTitle(element("new-note-template").value);
    if (!element("new-note-title").value.trim() || element("new-note-title").value === suggestedNoteTitle)
      element("new-note-title").value = title;
    suggestedNoteTitle = title;
    element("new-note-title").setAttribute("aria-invalid", "false");
    refreshNewNoteHint();
  });
  fileMenuReturnFocus = null;
}
export function refreshNewNoteHint(): void {
  try {
    setText(
      element("new-note-hint"),
      `File: ${noteName(notePathFromTitle(element("new-note-title").value, appState.newItemParent))}`,
    );
  } catch (errorCause) {
    const error = errorContext(errorCause);
    setText(element("new-note-hint"), error.message);
  }
}
export async function openNewNote(parentPath: string | null = null) {
  if (!projectCanCreate()) return;
  if (!libraryCatalog.loaded) return;
  cancelDocumentLoad();
  appState.newNoteOrigin = { id: documentSession.id, revision: documentSession.revision, root: appState.currentRoot };
  const parent =
    typeof parentPath === "string"
      ? parentPath
      : documentSession.current && !rootChanged() && documentSession.current.path.includes("/")
        ? documentSession.current.path.slice(0, documentSession.current.path.lastIndexOf("/"))
        : "";
  appState.newItemParent = parent;
  element("new-note-template").value = "blank";
  suggestedNoteTitle = templateTitle("blank");
  element("new-note-title").value = suggestedNoteTitle;
  element("new-note-title").setAttribute("aria-invalid", "false");
  refreshNewNoteHint();
  notice(element("new-note-error"), "");
  showDialog(element("new-note-dialog"));
  element("new-note-title").focus();
  element("new-note-title").select();
  return true;
}
export async function createNote(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (appState.creating) return;
  let path;
  let content;
  try {
    path = notePathFromTitle(element("new-note-title").value, appState.newItemParent);
    content = templateContent(element("new-note-template").value, element("new-note-title").value);
  } catch (errorCause) {
    const error = errorContext(errorCause);
    notice(element("new-note-error"), error.message, "error");
    element("new-note-title").setAttribute("aria-invalid", "true");
    element("new-note-title").focus();
    return;
  }
  if (!projectCanCreate() || requireValue(appState.newNoteOrigin).root !== appState.currentRoot) {
    notice(element("new-note-error"), "Connection changed, reopen New note", "error");
    return;
  }
  if (nameTaken(path)) {
    notice(element("new-note-error"), "Name already exists", "error");
    element("new-note-title").setAttribute("aria-invalid", "true");
    return;
  }
  const session = documentSession.id;
  const scope = projectModel.selection;
  if (
    !(await saveBeforeLeaving("create a new note")) ||
    session !== documentSession.id ||
    scope !== projectModel.selection ||
    !element("new-note-dialog").open
  )
    return;
  element("new-note-dialog").close();
  createTemplateFile(path, content, element("new-note-title").value.trim());
  if (shell.view === "preview") setView("rich");
  if (shell.view === "rich") appState.inlineEditor.focus();
  else appState.editor.focus();
}
export function closeFileContextMenu(restore = true): void {
  element("file-context-menu").hidden = true;
  element("file-context-menu").inert = true;
  appState.contextFile = null;
  addParent = null;
  fileMenuReturnFocus?.removeAttribute("aria-expanded");
  if (restore && fileMenuReturnFocus?.isConnected) fileMenuReturnFocus.focus({ preventScroll: true });
  fileMenuReturnFocus = null;
}
export function openFileContextMenu(
  event: MouseEvent,
  path: string,
  kind: "file" | "directory" = "file",
  add?: HTMLButtonElement,
  trigger?: HTMLButtonElement,
): void {
  if (!(event.target instanceof Element)) return;
  event.preventDefault();
  closeMenus();
  closeFileContextMenu(false);
  appState.contextFile = add ? null : { path, kind };
  addParent = add ? path : null;
  fileMenuReturnFocus = trigger ?? add ?? event.target.closest<HTMLElement>("[data-entry-path]");
  (trigger ?? add)?.setAttribute("aria-expanded", "true");
  element("tree-new-note").hidden = !add;
  element("tree-new-folder").hidden = !add;
  element("file-rename").hidden = Boolean(add) || publicState.publicView;
  const locked = !add && renameBlocked(path, kind);
  element("file-rename").disabled = !projectCanCreate() || !projectWritable(path) || appState.movingEntry || locked;
  element("file-rename-hint").hidden = !locked;
  if (locked) element("file-rename").setAttribute("aria-describedby", "file-rename-hint");
  else element("file-rename").removeAttribute("aria-describedby");
  element("file-duplicate").hidden = Boolean(add) || kind !== "file" || !projectCanCreate();
  element("file-details").hidden = Boolean(add) || kind !== "file" || publicState.publicView;
  element("file-recycle").hidden = Boolean(add) || !projectOwns();
  const note = kind === "file" && /\.(md|markdown)$/i.test(path);
  for (const action of element("file-context-menu").querySelectorAll<HTMLButtonElement>("[data-note-action]")) {
    const target = action.dataset.noteAction;
    action.hidden =
      Boolean(add) ||
      !note ||
      (target === "history-open" && !projectOwns()) ||
      (target === "document-tags-open" && !projectWritable(path));
  }
  for (const action of element("file-context-menu").querySelectorAll<HTMLButtonElement>("[data-file-action]")) {
    const type = action.dataset.fileAction;
    action.hidden =
      Boolean(add) ||
      (kind === "directory" && type !== "copy-path") ||
      (publicState.publicView && !["download", "copy-link", "reload"].includes(type ?? "")) ||
      (type === "share" && (!projectOwns() || authenticationSession.mode !== "users")) ||
      (type === "tags" && note) ||
      (type === "favorite" && authenticationSession.mode !== "users") ||
      (type === "tags" && !projectWritable(path));
    if (type === "favorite")
      setText(
        action,
        workspaceModel.lists.favorites.some((file) => file.project === projectModel.active?.id && file.path === path)
          ? "Unfavorite"
          : "Favorite",
      );
  }
  const anchor = requireValue(fileMenuReturnFocus).getBoundingClientRect();
  const x = (!add && !trigger && event.clientX) || anchor.left;
  const y = (!add && !trigger && event.clientY) || anchor.bottom;
  element("file-context-menu").hidden = false;
  element("file-context-menu").inert = false;
  element("file-context-menu").style.left = `${x}px`;
  element("file-context-menu").style.top = `${y}px`;
  element("file-context-menu")
    .querySelector<HTMLButtonElement>("button:not([hidden]):not(:disabled)")
    ?.focus({ preventScroll: true });
  window.requestAnimationFrame(() => {
    if (element("file-context-menu").hidden) return;
    const bounds = element("file-context-menu").getBoundingClientRect();
    element("file-context-menu").style.left = `${Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8))}px`;
    element("file-context-menu").style.top = `${Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8))}px`;
  });
}
export async function showFileDetails(): Promise<void> {
  const selected = appState.contextFile;
  closeFileContextMenu();
  if (!selected) return;
  const scope = projectModel.selection;
  try {
    const details =
      (await loadFileProperties(selected.path)) ??
      (await api(`/api/entry?id=${encodeURIComponent(await entryResourceId(selected.path))}`, {
        decode: decodedEntry,
      }));
    if (scope !== projectModel.selection) return;
    if (details.path !== selected.path) {
      throw new ApiError("Incomplete file details");
    }
    setText(element("details-name"), details.name);
    setText(element("details-metadata-title"), details.title || "—");
    setText(element("details-path"), details.path);
    setText(element("details-size"), formatByteCount(details.size));
    setText(
      element("details-modified"),
      details.modifiedUnixMs !== null ? new Date(details.modifiedUnixMs).toLocaleString() : "—",
    );
    showDialog(element("details-dialog"));
  } catch (errorCause) {
    const error = errorContext(errorCause);
    documentNotice(`Details failed: ${error.message}`, "error");
    connectionFailure(error);
  }
}
function renameBlocked(path: string, kind: "file" | "directory") {
  const room = collaboration;
  return !!room && !room.closed && (room.path === path || (kind === "directory" && room.path.startsWith(`${path}/`)));
}
export async function startTreeRename(selected = appState.contextFile): Promise<void> {
  closeFileContextMenu(false);
  if (!selected || !projectCanCreate() || !projectWritable(selected.path) || appState.movingEntry) return;
  if (renameBlocked(selected.path, selected.kind)) {
    documentNotice("End collaborative editing before renaming.", "warning");
    return;
  }
  if (document.body.dataset.sidebar === "closed") setSidebar(true);
  const row = () => element("file-list").querySelector<HTMLElement>(`[data-entry-path="${CSS.escape(selected.path)}"]`);
  if (!row() && element("file-filter").value) {
    element("file-filter").value = "";
    renderFiles();
  }
  const scope = projectModel.selection;
  const target = row();
  if (!target) return;
  try {
    const id = target.dataset.resourceId ?? (await entryResourceId(selected.path, selected.kind));
    if (scope !== projectModel.selection || !target.isConnected) return;
    target.dataset.resourceId = id;
  } catch (cause) {
    documentNotice(`Rename failed: ${errorContext(cause).message}`, "error");
    return;
  }
  const parts = selected.path.split("/");
  while (parts.pop() && parts.length) libraryModel.setCollapsed(parts.join("/"), false);
  libraryModel.rename({ ...selected, id: target.dataset.resourceId });
}
export function finishTreeRename(input: HTMLInputElement, focus: boolean, cancel = false): void {
  const entry = libraryView.rename;
  if (!entry || input.dataset.renamePath !== entry.path || appState.movingEntry) return;
  let name = input.value.trim();
  const oldName = entry.path.slice(entry.path.lastIndexOf("/") + 1);
  const updateLinks = input.parentElement?.querySelector<HTMLInputElement>("[data-update-links]")?.checked ?? true;
  let destination = entry.path;
  if (!cancel) {
    try {
      if (!name || /[\\/]/.test(name)) throw new Error("Enter a name without slashes");
      if (entry.kind === "file") {
        const ext = oldName.slice(oldName.lastIndexOf("."));
        if (!name.toLowerCase().endsWith(ext.toLowerCase())) name += ext;
      }
      destination = entryDestination(entry.path, entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))), name);
      (entry.kind === "file" && /\.(md|markdown)$/i.test(entry.path) ? validateNewNotePath : validateNewDirectoryPath)(
        destination,
      );
      if (destination !== entry.path && nameTaken(destination)) throw new Error("Name already exists");
      if (destination !== entry.path && !projectCanMove(entry.path, entry.kind, destination))
        throw new Error("Cannot rename here");
    } catch (cause) {
      libraryModel.renameError(errorContext(cause).message);
      return;
    }
  }
  const row = (path: string) =>
    element("file-list").querySelector<HTMLElement>(`[data-entry-path="${CSS.escape(path)}"]`);
  if (destination === entry.path) {
    libraryModel.rename(null);
    if (focus) row(entry.path)?.focus({ preventScroll: true });
    return;
  }
  const id = entry.id;
  input.readOnly = true;
  void moveLibraryEntry(entry, destination, updateLinks, (message) => {
    if (libraryView.rename?.id === id) libraryModel.renameError(message);
  }).then((moved) => {
    input.readOnly = false;
    if (libraryView.rename?.id !== id || !moved) return;
    libraryModel.rename(null);
    if (focus && (document.activeElement === input || document.activeElement === document.body))
      row(destination)?.focus({ preventScroll: true });
  });
}
export async function moveLibraryEntry(
  entry: {
    path: string;
    kind: "file" | "directory";
    id?: string;
  },
  destination: string,
  updateLinks = true,
  onError?: (message: string) => void,
) {
  if (appState.movingEntry || entry.path === destination || !projectCanMove(entry.path, entry.kind, destination))
    return false;
  const activePath = documentSession.current?.path;
  const panelPath = activePanelPath();
  const affectsPanel =
    panelPath && (panelPath === entry.path || (entry.kind === "directory" && panelPath.startsWith(`${entry.path}/`)));
  const affectsActive =
    activePath === entry.path || (entry.kind === "directory" && activePath?.startsWith(`${entry.path}/`));
  const scope = projectModel.selection;
  const owner = authenticationSession.scope;
  const root = appState.currentRoot;
  const currentScope = () => !owner.signal.aborted && scope === projectModel.selection && root === appState.currentRoot;
  const session = documentSession.id;
  const revision = documentSession.revision;
  const activeResource = documentSession.current?.id;
  appState.movingEntry = true;
  libraryModel.moving(entry.path, destination);
  refreshControls();
  try {
    if (affectsPanel && !(await leaveFilePanel())) return false;
    if (documentSession.saving) await documentSession.saving.completion;
    await waitForConnection(owner.signal);
    if (!currentScope() || !projectCanMove(entry.path, entry.kind, destination)) return false;
    const result = await api("/api/entry", {
      decode: decodedMove,
      method: "PATCH",
      signal: owner.signal,
      body: {
        id: entry.id ?? currentResourceId(entry.path, entry.kind === "directory" ? "directory" : "document"),
        destination,
        updateLinks,
      },
    });
    if (!result || typeof result.path !== "string" || result.kind !== entry.kind || !isResourceId(result.id)) {
      throw new ApiError("Incomplete move result");
    }
    if (!currentScope()) return true;
    destination = result.path;
    relocateEntryIcons(entry.path, destination);
    if (authenticationSession.mode === "users") void loadUserWorkspace();
    if (affectsActive && session === documentSession.id && activeResource === documentSession.current?.id) {
      const nextPath = `${destination}${requireValue(activePath).slice(entry.path.length)}`;
      // A move acknowledgement must not replace keystrokes made before or during the request.
      documentSession.relocate(nextPath);
      if (
        result.document &&
        documentSession.current?.content !== result.document.content &&
        revision === documentSession.revision &&
        !dirty() &&
        !documentSession.saving
      ) {
        useDocument(expectDocument(result.document), appState.currentRoot, new URL(appState.committedUrl), "replace");
      }
    }
    await refreshFiles();
    if (affectsPanel && currentScope()) await openFilePanel(`${destination}${panelPath.slice(entry.path.length)}`);
    documentNotice(result.warning ?? "", result.warning ? "warning" : "");
    return true;
  } catch (errorCause) {
    const error = errorContext(errorCause);
    const message = `Move failed: ${error.message}`;
    if (currentScope()) {
      onError?.(error.message);
      documentNotice(message, "error");
      connectionFailure(error);
    }
    return false;
  } finally {
    appState.movingEntry = false;
    libraryModel.finishMove(entry.path);
    refreshControls();
    if (dirty()) scheduleAutoSave();
  }
}
export function setView(view: unknown, focus = false): void {
  if (!isDocumentView(view)) throw new Error(`Unknown document view: ${view}`);
  const previousView = shell.view;
  if (view !== previousView) {
    const selection = captureViewPosition(previousView);
    documentState.pendingViewPosition = selection ? { ...selection, document: documentSession.id, focus } : null;
  }
  if (["editor", "split"].includes(view)) appState.editor.prepare();
  updateShell({ view });
  const visiblePanes = new Set(
    view === "split" ? ["editor-pane", "preview-pane"] : [`${view === "rich" ? "rich" : view}-pane`],
  );
  for (const pane of htmlChildren(element("document-panes"))) {
    const visible = [...visiblePanes].some((className) => pane.classList.contains(className));
    pane.inert = !visible;
    pane.setAttribute("aria-hidden", String(!visible));
  }
  if (view !== previousView) {
    appState.inlineEditor.dismissMenus();
    if (view === "rich") notice(element("rich-warning"), "");
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
    if (view === "preview") element("preview").focus();
    else if (view === "rich") appState.inlineEditor.focus();
    else if (documentSession.current) appState.editor.focus({ preventScroll: true });
  }
}
export async function copyText(conflict = false): Promise<void> {
  if (!documentSession.current) return;
  const text = appState.editor.value;
  const id = documentSession.id;
  clearTimer(appState.copyTimer);
  try {
    await copyPlainText(text);
    if (id !== documentSession.id) return;
    if (conflict) setText(element("conflict-copy"), "Copied");
    setText(element("copy-text"), "Copied");
    setText(element("copy-status"), "Copied");
  } catch {
    if (id === documentSession.id) {
      setView("editor");
      appState.editor.focus();
      appState.editor.select();
      setText(element("copy-text"), `Press ${primaryShortcut("C")}`);
      setText(element("copy-status"), `Clipboard unavailable, press ${primaryShortcut("C")}`);
      documentNotice(`Clipboard unavailable, press ${primaryShortcut("C")}`);
    }
  }
  appState.copyTimer = window.setTimeout(() => {
    setText(element("copy-text"), "Copy Markdown");
    setText(element("conflict-copy"), "Copy my edits");
    setText(element("copy-status"), "");
  }, 3000);
}
import { copyPlainText } from "../../../shared/clipboard";
import { primaryShortcut } from "../../../shared/keyboard";
