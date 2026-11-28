import { projectModel } from "../../state/projects";
import { authenticationSession } from "../../state/authentication";
import { documentSession } from "../../state/document";
import { expandedPageUrl, makeNoteUrl, readNoteRoute, unresolvedPage } from "@folio/model";
import { activePanelPath, libraryCatalog } from "../../state/library";
import { saveFilePanel } from "../navigation/panels";
import { shell, viewLabels } from "../../state/shell";
import { installInputDiagnostics } from "../../diagnostics/install";
import { element, clearTimer, datasetValue, entryKind } from "../../types/elements";
import { isRecord } from "../../types/guards";
import {
  bootstrapAuthentication,
  closeMenus,
  renderDocumentStatus,
  scheduleControlRefresh,
  restoreSidebar,
  setSidebar,
  toggleFocusMode,
} from "../accounts/authentication";
import { collaborationChanged, collaboration } from "../collaboration/collaboration";
import { hasDialogConfirmation } from "../dialogs/dialogs";
import { queueDraftPersistence } from "../documents/drafts";
import { initializeDiskSync } from "../documents/disk";
import {
  cancelDocumentLoad,
  commitUrl,
  internalNoteUrl,
  navigateTo,
  restoreCommittedUrl,
} from "../documents/navigation";
import { resolvePageRoute } from "../documents/page-route";
import { schedulePreview, scrollToHeading } from "../documents/preview";
import { saveDocument, scheduleAutoSave } from "../documents/saving";
import { applicationLifetime, listen } from "../lifecycle";
import { closeFileContextMenu, openFileContextMenu, setView } from "../navigation/files";
import { initializeTreeDrag } from "../navigation/drag";
import { hasPendingImages } from "../documents/images";
import { libraryView } from "../../state/library";
import { libraryState, refreshFiles, scheduleTreeRefresh } from "../navigation/library";
import {
  closeDocumentOutline,
  openDocumentOutline,
  scheduleOutlineRefresh,
  setCurrentOutline,
} from "../navigation/outline";
import { settingsState } from "../preferences/settings";
import { switchProject } from "../projects/projects";
import { publicState } from "../sharing/public";
import { refreshAppearance, stopAppearancePolling } from "./appearance";
import { appState, currentEditorAnalysis, dirty } from "./bootstrap";
import { openCommandPanel, opensCommandPanel } from "./commands";
import { documentNotice, notice } from "./dom";
import { setSidebarWidth } from "./layout";
export function initializeCoreEvents(): void {
  initializeDiskSync();
  listen(element("outline-list"), "click", (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>("button[data-heading]");
    if (!button || !documentSession.current) return;
    const heading = appState.outlineItems[Number(button.dataset.heading)];
    if (!heading) return;
    setCurrentOutline(heading.id);
    if (shell.view === "rich") {
      if (element("rich-editor").getAttribute("aria-busy") === "true") appState.pendingHeading = heading.id;
      else appState.inlineEditor.jumpTo(heading.id, { block: "start" });
    } else if (shell.view === "preview") scrollToHeading(`#${encodeURIComponent(heading.id)}`);
    else appState.editor.jumpTo(heading.from);
    if (appState.compactLayout.matches) closeDocumentOutline({ dismiss: true });
  });
  listen(appState.compactLayout, "change", () => setSidebar(!appState.compactLayout.matches, true));
  listen(window, "resize", () => setSidebarWidth(appState.preferredSidebarWidth));
  listen(document, "pointerdown", (event) => {
    if (!(event.target instanceof Element)) return;
    if (
      !element("file-context-menu").hidden &&
      !element("file-context-menu").contains(event.target) &&
      !event.target.closest("#panel-more")
    ) {
      closeFileContextMenu();
    }
  });
  listen(document, "click", (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest<HTMLDetailsElement>(".popup-panel button, .popup-panel a")) closeMenus();
  });
  listen(element("file-list"), "contextmenu", (event) => {
    if (!(event.target instanceof Element)) return;
    const entry = event.target.closest<HTMLElement>("[data-entry-path]");
    if (entry) openFileContextMenu(event, datasetValue(entry, "entryPath"), entryKind(entry));
  });
  initializeTreeDrag();
  listen(appState.editor, "input", (event) => {
    if (!documentSession.current) return;
    // Even an edit followed by undo can leave the same text with a different redo branch.
    if (shell.view !== "rich") appState.inlineEditorPath = null;
    documentSession.edited();
    if (cancelDocumentLoad()) documentNotice("Open canceled");
    renderDocumentStatus(true);
    collaborationChanged();
    queueDraftPersistence(true);
    scheduleAutoSave();
    // Re-reading a long note for its outline, word count and size takes real time, so those wait for a
    // pause that grows with the note instead of running between keystrokes.
    const patience = Math.min(1500, appState.editor.value.length / 4096);
    scheduleOutlineRefresh(
      event instanceof CustomEvent && isRecord(event.detail) ? event.detail.changes : undefined,
      settingsState.webPreferences.outlineDelayMs + patience,
    );
    scheduleControlRefresh(180 + patience);
    schedulePreview();
  });
  listen(element("preview"), "click", (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest<HTMLAnchorElement>("a[href]");
    if (!link || !documentSession.current) return;
    const href = link.getAttribute("href");
    if (!href) return;
    if (href.startsWith("#")) {
      event.preventDefault();
      commitUrl(makeNoteUrl(appState.committedUrl, documentSession.resourceId, href));
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
  // Focus surfaces follow keyboard navigation only, so Escape after a click leaves the trigger quiet.
  listen(
    window,
    "keydown",
    (event) => {
      if (event.key === "Tab" || event.key.startsWith("Arrow")) document.documentElement.dataset.input = "keyboard";
    },
    true,
  );
  listen(window, "pointerdown", () => delete document.documentElement.dataset.input, true);
  if (CSS.supports("selector(select:open)")) {
    listen(document.body, "keydown", (event) => {
      // Let the browser dismiss the picker before the surrounding dialog or menu handles Escape.
      if (event.key === "Escape" && event.target instanceof Element && event.target.closest("select:open")) {
        event.stopPropagation();
      }
    });
  }
  listen(window, "keydown", (event) => {
    if (event.isComposing) return;
    const modal = document.querySelector<HTMLDialogElement>("dialog[open]");
    if (modal && modal !== element("command-dialog")) {
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
      closeMenus();
      if (appState.compactLayout.matches) setSidebar(false, true);
    }
    if (!(event.ctrlKey || event.metaKey)) return;
    if (event.shiftKey && event.key.toLowerCase() === "l") {
      event.preventDefault();
      setSidebar(document.body.dataset.sidebar !== "open", true);
      return;
    }
    if (activePanelPath()) {
      if (!event.shiftKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveFilePanel();
      }
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
    if (element("new-note-dialog").open) {
      if (!appState.creating) notice(element("new-note-error"), "Create note or cancel");
    } else {
      void saveDocument();
    }
  });
  listen(window, "focus", () => {
    void refreshAppearance(true);
    // The file list follows the disk on its own: returning to the window is the moment it may have changed.
    if (appState.connectionState === "ready" && !libraryCatalog.loading) void refreshFiles();
    else scheduleTreeRefresh();
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
    if (
      !dirty() &&
      !documentSession.saving &&
      !appState.creating &&
      !appState.movingEntry &&
      !libraryView.pending.length &&
      !hasPendingImages()
    )
      return;
    event.preventDefault();
    event.returnValue = "";
  });
  listen(window, "popstate", async () => {
    const current = window.location.href;
    let url: URL;
    try {
      url = await resolvePageRoute(current, authenticationSession.scope.signal);
    } catch {
      if (current === window.location.href) {
        restoreCommittedUrl();
        documentNotice("Link unavailable.", "warning");
      }
      return;
    }
    if (current !== window.location.href) return;
    if (
      authenticationSession.mode === "users" &&
      url.searchParams.has("project") &&
      url.searchParams.get("project") !== projectModel.active?.id
    ) {
      void switchProject(url.searchParams.get("project"), { url, mode: "pop" });
      return;
    }
    const route = readNoteRoute(url);
    void navigateTo(route.id ?? (publicState.publicView ? documentSession.resourceId : null), route.hash, {
      mode: "pop",
      url,
    });
  });
  listen(window, "hashchange", () => {
    if (documentSession.loading) return;
    if (unresolvedPage(expandedPageUrl(window.location.href))) return;
    const route = readNoteRoute(window.location.href);
    if (route.id === (documentSession.current?.id ?? null) || publicState.publicView) {
      const next = new URL(appState.committedUrl);
      next.hash = route.hash;
      appState.committedUrl = next.href;
      if (route.hash !== "#editor") scrollToHeading(route.hash);
    }
  });
  restoreSidebar();
  void bootstrapAuthentication();
  if (new URLSearchParams(window.location.search).get("perf") === "1") {
    installInputDiagnostics(
      applicationLifetime(),
      {
        textarea: element("editor"),
        context_fn: () => ({
          view: viewLabels[shell.view],
          collaborative: Boolean(collaboration?.connected),
          saving: Boolean(documentSession.saving || collaboration?.saving),
          outline: element("outline-tab").getAttribute("aria-expanded") === "true",
          documentBytes: currentEditorAnalysis().bytes,
        }),
      },
      (error) => documentNotice(`Diagnostics failed: ${error.message}`, "error"),
    );
  }
}
