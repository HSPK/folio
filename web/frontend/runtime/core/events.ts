import { projectModel } from "../../state/projects";
import { connect } from "./connection";
import { authenticationSession } from "../../state/authentication";
import { documentSession } from "../../state/document";
import { entryDestination, makeNoteUrl, readNoteRoute } from "@folio/model";
import { shell, viewLabels } from "../../state/shell";
import { installInputDiagnostics } from "../../diagnostics/install";
import { clearTimer, datasetValue, entryKind, requireValue } from "../../types/elements";
import { isRecord } from "../../types/guards";
import {
  bootstrapAuthentication,
  closeMenus,
  logout,
  renderDocumentStatus,
  scheduleControlRefresh,
  selectNavigation,
  setSidebar,
  showAuthentication,
  submitAuthentication,
  toggleFocusMode,
} from "../accounts/authentication";
import { collaborationChanged, collaborationState } from "../collaboration/collaboration";
import { hasDialogConfirmation } from "../dialogs/dialogs";
import { queueDraftPersistence } from "../documents/drafts";
import { cancelDocumentLoad, commitUrl, internalNoteUrl, navigateTo } from "../documents/navigation";
import { schedulePreview, scrollToHeading } from "../documents/preview";
import { saveDocument, scheduleAutoSave } from "../documents/saving";
import { applicationLifetime, listen } from "../lifecycle";
import {
  closeFileContextMenu,
  copyText,
  createFolder,
  createNote,
  moveLibraryEntry,
  openFileContextMenu,
  openNewFolder,
  openNewNote,
  openRenameDialog,
  refreshNewNoteHint,
  renameChanged,
  renameEntry,
  setDropTarget,
  setView,
  showFileDetails,
} from "../navigation/files";
import { libraryState, refreshFiles, scheduleFileFilterRender, scheduleTreeRefresh } from "../navigation/library";
import {
  closeDocumentOutline,
  openDocumentOutline,
  scheduleOutlineRefresh,
  setCurrentOutline,
} from "../navigation/outline";
import { openSettings } from "../preferences/settings";
import { switchProject } from "../projects/projects";
import { publicState } from "../sharing/public";
import { refreshAppearance, stopAppearancePolling } from "./appearance";
import { appState, currentEditorAnalysis, dirty } from "./bootstrap";
import {
  closeCommandPanel,
  commandState,
  openCommandPanel,
  opensCommandPanel,
  renderCommandPanel,
  runCommand,
  selectCommand,
} from "./commands";
import { documentNotice, notice } from "./dom";
import { setPageWidth, setSidebarWidth } from "./layout";
export function initializeCoreEvents(): void {
  applicationLifetime().defer(() => delete document.body.dataset.resizingSidebar);
  listen(appState.ui.authForm, "submit", (event) => void submitAuthentication(event));
  listen(appState.ui.logout, "click", () => void logout());
  listen(appState.ui.commandOpen, "click", openCommandPanel);
  listen(appState.ui.commandClose, "click", closeCommandPanel);
  listen(appState.ui.commandForm, "submit", (event) => {
    event.preventDefault();
    runCommand();
  });
  listen(appState.ui.commandQuery, "input", () => {
    commandState.commandIndex = 0;
    renderCommandPanel();
  });
  listen(appState.ui.commandQuery, "keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      selectCommand(commandState.commandIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      selectCommand(commandState.commandIndex - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      runCommand();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeCommandPanel();
    }
  });
  listen(appState.ui.reconnect, "click", () => {
    if (authenticationSession.mode === "users" && !authenticationSession.user) showAuthentication(false);
    else void connect();
  });
  listen(appState.ui.sidebarToggle, "click", () => setSidebar(document.body.dataset.sidebar !== "open"));
  listen(appState.element("sidebar-hide"), "click", () => setSidebar(false));
  listen(appState.element("sidebar-settings-open"), "click", () => openSettings());
  listen(appState.ui.scrim, "click", () => setSidebar(false));
  listen(appState.ui.filesTab, "click", () => selectNavigation("files"));
  listen(appState.ui.outlineList, "click", (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>("button[data-heading]");
    if (!button || !documentSession.current) return;
    const heading = appState.outlineItems[Number(button.dataset.heading)];
    if (!heading) return;
    setCurrentOutline(heading.id);
    if (shell.view === "rich") {
      if (appState.element("rich-editor").getAttribute("aria-busy") === "true") appState.pendingHeading = heading.id;
      else appState.inlineEditor.jumpTo(heading.id, { block: "start" });
    } else if (shell.view === "preview") scrollToHeading(`#${encodeURIComponent(heading.id)}`);
    else appState.ui.editor.jumpTo(heading.from);
    if (appState.compactLayout.matches) closeDocumentOutline({ dismiss: true });
  });
  listen(appState.ui.focusMode, "click", toggleFocusMode);
  listen(appState.ui.emptyNew, "click", () => openNewNote());
  listen(appState.compactLayout, "change", () => setSidebar(!appState.compactLayout.matches));
  listen(window, "resize", () => setSidebarWidth(appState.preferredSidebarWidth));
  listen(appState.ui.sidebarResizer, "pointerdown", (event) => {
    if (event.button !== 0 || appState.compactLayout.matches || document.body.dataset.sidebar !== "open") return;
    event.preventDefault();
    document.body.dataset.resizingSidebar = "true";
    appState.ui.sidebarResizer.setPointerCapture(event.pointerId);
    setSidebarWidth(event.clientX);
  });
  listen(appState.ui.sidebarResizer, "pointermove", (event) => {
    if (!appState.ui.sidebarResizer.hasPointerCapture(event.pointerId)) return;
    setSidebarWidth(event.clientX);
  });
  const finishSidebarResize = (event: PointerEvent) => {
    if (!appState.ui.sidebarResizer.hasPointerCapture(event.pointerId)) return;
    appState.ui.sidebarResizer.releasePointerCapture(event.pointerId);
    delete document.body.dataset.resizingSidebar;
    setSidebarWidth(appState.preferredSidebarWidth, true);
  };
  listen(appState.ui.sidebarResizer, "pointerup", finishSidebarResize);
  listen(appState.ui.sidebarResizer, "pointercancel", finishSidebarResize);
  listen(appState.ui.sidebarResizer, "lostpointercapture", () => {
    delete document.body.dataset.resizingSidebar;
  });
  listen(appState.ui.sidebarResizer, "dblclick", () => setSidebarWidth(appState.SIDEBAR_DEFAULT, true));
  listen(appState.ui.sidebarResizer, "keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
    event.preventDefault();
    const width =
      event.key === "Home"
        ? appState.SIDEBAR_DEFAULT
        : appState.preferredSidebarWidth + (event.key === "ArrowLeft" ? -10 : 10);
    setSidebarWidth(width, true);
  });
  for (const button of document.querySelectorAll<HTMLElement>("[data-page-width]")) {
    listen(button, "click", () => setPageWidth(button.dataset.pageWidth, true));
  }
  listen(document, "pointerdown", (event) => {
    if (!(event.target instanceof Element)) return;
    if (!appState.ui.fileContextMenu.hidden && !appState.ui.fileContextMenu.contains(event.target)) {
      closeFileContextMenu();
    }
    for (const popup of document.querySelectorAll<HTMLDetailsElement>(".popup[open]")) {
      if (!popup.contains(event.target)) popup.open = false;
    }
  });
  listen(document, "click", (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest<HTMLDetailsElement>(".popup-panel button, .popup-panel a")) closeMenus();
  });
  listen(appState.ui.refreshFiles, "click", () => void refreshFiles());
  listen(appState.ui.filter, "input", scheduleFileFilterRender);
  listen(appState.ui.fileList, "contextmenu", (event) => {
    if (!(event.target instanceof Element)) return;
    const entry = event.target.closest<HTMLElement>("[data-entry-path]");
    if (entry) openFileContextMenu(event, datasetValue(entry, "entryPath"), entryKind(entry));
  });
  listen(appState.ui.fileContextMenu, "keydown", (event) => {
    const items = [
      ...appState.ui.fileContextMenu.querySelectorAll<HTMLButtonElement>("button:not([hidden]):not(:disabled)"),
    ];
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const active = document.activeElement;
      const index = active instanceof HTMLButtonElement ? items.indexOf(active) : -1;
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    } else if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") event.preventDefault();
      closeFileContextMenu();
    }
    event.stopPropagation();
  });
  listen(appState.ui.fileList, "dragstart", (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest<HTMLElement>(".directory-actions")) {
      event.preventDefault();
      return;
    }
    const entry = event.target.closest<HTMLElement>("[data-entry-path]");
    if (!entry) return;
    appState.draggedEntry = { path: datasetValue(entry, "entryPath"), kind: entryKind(entry) };
    entry.setAttribute("data-dragging", "true");
    requireValue(event.dataTransfer).effectAllowed = "move";
    requireValue(event.dataTransfer).setData("text/plain", requireValue(appState.draggedEntry).path);
  });
  listen(appState.ui.fileList, "dragend", () => {
    for (const entry of appState.ui.fileList.querySelectorAll<HTMLElement>("[data-dragging]")) {
      entry.removeAttribute("data-dragging");
    }
    appState.draggedEntry = null;
    setDropTarget(null);
  });
  listen(appState.ui.appShell, "dragover", (event) => {
    if (!(event.target instanceof Element)) return;
    if (!appState.draggedEntry) return;
    const target = event.target.closest<HTMLElement>("[data-directory-path]");
    if (!target) {
      setDropTarget(null);
      return;
    }
    const directory = datasetValue(target, "directoryPath");
    const destination = entryDestination(appState.draggedEntry.path, directory);
    if (
      destination === appState.draggedEntry.path ||
      (appState.draggedEntry.kind === "directory" &&
        (directory === appState.draggedEntry.path ||
          requireValue(directory).startsWith(`${appState.draggedEntry.path}/`)))
    ) {
      setDropTarget(null);
      return;
    }
    event.preventDefault();
    requireValue(event.dataTransfer).dropEffect = "move";
    setDropTarget(target.closest<HTMLElement>(".directory") ?? target);
  });
  listen(appState.ui.appShell, "drop", (event) => {
    if (!(event.target instanceof Element)) return;
    if (!appState.draggedEntry) return;
    const target = event.target.closest<HTMLElement>("[data-directory-path]");
    if (!target) return;
    event.preventDefault();
    const entry = appState.draggedEntry;
    const destination = entryDestination(entry.path, datasetValue(target, "directoryPath"));
    appState.draggedEntry = null;
    setDropTarget(null);
    void moveLibraryEntry(entry, destination);
  });
  listen(appState.ui.reload, "click", () => {
    if (documentSession.current)
      void navigateTo(documentSession.current.id, readNoteRoute(appState.committedUrl).hash, {
        mode: "replace",
        reload: true,
      });
  });
  listen(appState.ui.copy, "click", () => void copyText());
  listen(appState.ui.newNote, "click", () => openNewNote());
  listen(appState.ui.newFolder, "click", () => openNewFolder());
  listen(appState.ui.newForm, "submit", (event) => void createNote(event));
  listen(appState.ui.newFolderForm, "submit", (event) => void createFolder(event));
  listen(appState.ui.cancelNew, "click", () => {
    if (!appState.creating) appState.ui.newDialog.close();
  });
  listen(appState.ui.newDialog, "cancel", (event) => {
    if (appState.creating) event.preventDefault();
  });
  listen(appState.ui.newTitle, "input", () => {
    appState.ui.newTitle.setAttribute("aria-invalid", "false");
    refreshNewNoteHint();
  });
  listen(appState.ui.cancelNewFolder, "click", () => {
    if (!appState.creating) appState.ui.newFolderDialog.close();
  });
  listen(appState.ui.newFolderDialog, "cancel", (event) => {
    if (appState.creating) event.preventDefault();
  });
  listen(appState.ui.newFolderPath, "input", () => appState.ui.newFolderPath.setAttribute("aria-invalid", "false"));
  listen(appState.ui.fileDetails, "click", () => void showFileDetails());
  listen(appState.ui.fileRename, "click", openRenameDialog);
  listen(appState.ui.renameForm, "submit", (event) => void renameEntry(event));
  listen(appState.ui.cancelRename, "click", () => {
    if (!appState.movingEntry) {
      appState.ui.renameDialog.close();
      appState.contextFile = null;
    }
  });
  listen(appState.ui.renameDialog, "cancel", (event) => {
    if (appState.movingEntry) event.preventDefault();
    else appState.contextFile = null;
  });
  listen(appState.ui.renamePath, "input", () => {
    appState.ui.renamePath.setAttribute("aria-invalid", "false");
    appState.ui.confirmRename.disabled = appState.movingEntry || !renameChanged();
  });
  listen(appState.ui.closeDetails, "click", () => appState.ui.detailsDialog.close());
  for (const button of document.querySelectorAll<HTMLButtonElement>(".view-options button")) {
    listen(button, "click", () => setView(button.dataset.view, true));
  }
  listen(requireValue(document.querySelector<HTMLElement>(".skip-link")), "click", (event) => {
    event.preventDefault();
    if (shell.view === "rich") appState.inlineEditor.focus();
    else if (shell.view === "preview") appState.ui.preview.focus();
    else appState.ui.editor.focus();
  });
  listen(appState.ui.editor, "input", (event) => {
    if (!documentSession.current) return;
    documentSession.edited();
    if (cancelDocumentLoad()) documentNotice("Opening a note was canceled because you continued editing.");
    renderDocumentStatus(true);
    collaborationChanged();
    queueDraftPersistence(true);
    scheduleAutoSave();
    scheduleOutlineRefresh(event instanceof CustomEvent && isRecord(event.detail) ? event.detail.changes : undefined);
    scheduleControlRefresh();
    schedulePreview();
  });
  listen(appState.ui.preview, "click", (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest<HTMLAnchorElement>("a[href]");
    if (!link || !documentSession.current) return;
    const href = link.getAttribute("href");
    if (!href) return;
    if (href.startsWith("#")) {
      event.preventDefault();
      commitUrl(makeNoteUrl(appState.committedUrl, documentSession.current.id, href));
      scrollToHeading(href);
      return;
    }
    let url;
    try {
      url = new URL(href, window.location.href);
    } catch {
      return;
    }
    if (internalNoteUrl(url)) {
      event.preventDefault();
      const route = readNoteRoute(url);
      void navigateTo(route.id ?? (publicState.publicView ? documentSession.current.id : null), route.hash, { url });
    }
  });
  listen(window, "keydown", (event) => {
    if (event.isComposing) return;
    const modal = document.querySelector<HTMLDialogElement>("dialog[open]");
    if (modal && modal !== appState.ui.commandDialog) {
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (hasDialogConfirmation(modal)) return;
        const form = [...modal.querySelectorAll<HTMLFormElement>("form")].find(
          (form) => !form.closest<HTMLElement>("[hidden], [inert]"),
        );
        form?.requestSubmit();
      }
      return;
    }
    if (opensCommandPanel(event)) {
      event.preventDefault();
      openCommandPanel();
      return;
    }
    if (event.key === "Escape") {
      const popup = document.activeElement?.closest<HTMLDetailsElement>(".popup[open]");
      closeMenus();
      popup?.querySelector<HTMLElement>(":scope > summary")?.focus({ preventScroll: true });
      if (appState.compactLayout.matches) setSidebar(false);
    }
    if (!(event.ctrlKey || event.metaKey)) return;
    if (event.shiftKey && event.key.toLowerCase() === "l") {
      event.preventDefault();
      setSidebar(document.body.dataset.sidebar !== "open");
      return;
    }
    if (event.shiftKey && (event.code === "Digit1" || event.key === "1")) {
      event.preventDefault();
      openDocumentOutline({ pin: true, focus: true });
      return;
    }
    if (event.shiftKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      toggleFocusMode();
      return;
    }
    if (!event.shiftKey && (event.key === "/" || event.code === "Slash")) {
      event.preventDefault();
      setView(shell.view === "rich" ? "editor" : "rich", true);
      return;
    }
    if (event.key.toLowerCase() !== "s") return;
    event.preventDefault();
    if (appState.ui.newDialog.open) {
      if (!appState.creating)
        notice(appState.ui.newError, "Choose Create note to create this file, or Cancel to return to the editor.");
    } else {
      void saveDocument();
    }
  });
  listen(window, "focus", () => {
    void refreshAppearance(true);
    scheduleTreeRefresh();
  });
  listen(window, "blur", stopAppearancePolling);
  listen(window, "pagehide", stopAppearancePolling);
  listen(document, "visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      stopAppearancePolling();
      clearTimer(libraryState.treeRefreshTimer);
    } else {
      void refreshAppearance(true);
      scheduleTreeRefresh();
    }
  });
  listen(window, "beforeunload", (event) => {
    if (!dirty() && !documentSession.saving && !appState.creating) return;
    event.preventDefault();
    event.returnValue = "";
  });
  listen(window, "popstate", () => {
    const url = new URL(window.location.href);
    if (authenticationSession.mode === "users" && url.searchParams.get("project") !== projectModel.active?.id) {
      void switchProject(url.searchParams.get("project"), { url, mode: "pop" });
      return;
    }
    const route = readNoteRoute(url);
    void navigateTo(route.id, route.hash, { mode: "pop", url });
  });
  listen(window, "hashchange", () => {
    if (documentSession.loading) return;
    const route = readNoteRoute(window.location.href);
    if (route.id === (documentSession.current?.id ?? null) || publicState.publicView) {
      appState.committedUrl = window.location.href;
      if (route.hash !== "#editor") scrollToHeading(route.hash);
    }
  });
  setSidebar(!appState.compactLayout.matches);
  void bootstrapAuthentication();
  if (new URLSearchParams(window.location.search).get("perf") === "1") {
    installInputDiagnostics(
      applicationLifetime(),
      {
        textarea: appState.element("editor"),
        context_fn: () => ({
          view: viewLabels[shell.view],
          collaborative: Boolean(collaborationState.collaboration?.connected),
          saving: Boolean(documentSession.saving || collaborationState.collaboration?.saving),
          outline: appState.ui.outlineTab.getAttribute("aria-expanded") === "true",
          documentBytes: currentEditorAnalysis().bytes,
        }),
      },
      (error) => documentNotice(`Input diagnostics could not start: ${error.message}`, "error"),
    );
  }
}
