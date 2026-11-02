import { authenticationSession } from "../../state/authentication";
import { documentSession } from "../../state/document";
import { libraryModel } from "../../state/library";
import {
  attachScrollbars,
  type createOutlineExtractor,
  createSourceEditor,
  hydrateIcons,
  type SourceChanges,
} from "@folio/editor-runtime";
import { RequestGate, createWordCounter, readLaunchUrl, type DocumentSessionId } from "@folio/model";
import type { Heading, InlineEditor } from "../../types/domain";
import { clearTimer, element, requiredQuery } from "../../types/elements";
import { notice } from "./notice";
import { onApplicationDispose, ownApplicationResource } from "../lifecycle";
class AppState {
  element!: typeof element;
  ui!: ReturnType<typeof createApplicationUi>;
  compactLayout!: MediaQueryList;
  SIDEBAR_WIDTH_KEY!: string;
  PAGE_WIDTH_KEY!: string;
  COMMAND_SHORTCUT_KEY!: string;
  HIDDEN_PATTERNS_KEY!: string;
  SIDEBAR_MIN!: number;
  SIDEBAR_MAX!: number;
  SIDEBAR_DEFAULT!: number;
  pageWidths!: Set<string>;
  outlineItems!: Heading[];
  outlineSource!: string | null;
  outlineButtons!: HTMLButtonElement[];
  outlineById!: Map<string, HTMLButtonElement>;
  currentOutlineButton!: HTMLButtonElement | null;
  focusAfterLoad!: boolean;
  pendingHeading!: string | number | null;
  sidebarBeforeFocus!: boolean;
  wordSource!: string | null;
  wordCount!: number;
  wordCounter!: ReturnType<typeof createWordCounter>;
  TOKEN_KEY!: string;
  launch!: ReturnType<typeof readLaunchUrl>;
  token!: string | null;
  storageUnavailable!: boolean;
  committedUrl!: string;
  authenticationRecovery!: {
    id: DocumentSessionId;
    resource?: string;
    participant: string | null;
    ready: boolean;
  } | null;
  authSetup!: boolean;
  authenticating!: boolean;
  connectionState!: string;
  currentRoot!: string | null;
  currentPort!: number | null;
  creating!: boolean;
  newNoteOrigin!: {
    id: DocumentSessionId;
    revision: number;
    root: string | null;
  } | null;
  newItemParent!: string;
  contextFile!: {
    path: string;
    kind: "file" | "directory";
  } | null;
  movingEntry!: boolean;
  draggedEntry!: {
    path: string;
    kind: "file" | "directory";
  } | null;
  dropTarget!: HTMLElement | null;
  previewTimer!: number | null;
  previewController!: AbortController | null;
  renderedPreviewDocument!: DocumentSessionId | null;
  renderedPreviewRevision!: number;
  connectionController!: AbortController | null;
  treeController!: AbortController | null;
  copyTimer!: number | null;
  deferredControlTimer!: number | null;
  outlineTimer!: number | null;
  outlineChanges!: SourceChanges | null;
  appearanceController!: AbortController | null;
  appearanceTimer!: number | null;
  appearanceGeneration!: number;
  connectionGate!: RequestGate;
  treeGate!: RequestGate;
  previewGate!: RequestGate;
  inlineEditorPath!: string | null;
  outlineExtractor!: ReturnType<typeof createOutlineExtractor>;
  inlineEditor!: InlineEditor;
  preferredSidebarWidth!: number;
  commandShortcut!: string;
}
export const appState = new AppState();
export function initializeCoreBootstrap(): void {
  hydrateIcons(document);
  appState.element = element;
  appState.ui = createApplicationUi();
  appState.compactLayout = window.matchMedia("(max-width: 650px)");
  appState.SIDEBAR_WIDTH_KEY = "folio.layout.sidebarWidth";
  appState.PAGE_WIDTH_KEY = "folio.layout.pageWidth";
  appState.COMMAND_SHORTCUT_KEY = "folio.shortcuts.commandPanel";
  appState.HIDDEN_PATTERNS_KEY = "folio.library.hiddenPatterns";
  appState.SIDEBAR_MIN = 210;
  appState.SIDEBAR_MAX = 420;
  appState.SIDEBAR_DEFAULT = 260;
  appState.pageWidths = new Set(["focused", "balanced", "wide"]);
  appState.outlineItems = [];
  appState.outlineSource = null;
  appState.outlineButtons = [];
  appState.outlineById = new Map();
  appState.currentOutlineButton = null;
  appState.focusAfterLoad = false;
  appState.pendingHeading = null;
  appState.sidebarBeforeFocus = true;
  appState.wordSource = null;
  appState.wordCount = 0;
  appState.wordCounter = createWordCounter();
  appState.TOKEN_KEY = "folio.connection.token";
  appState.launch = readLaunchUrl(window.location.href);
  appState.token = appState.launch.token;
  appState.storageUnavailable = false;
  try {
    if (appState.token) window.sessionStorage.setItem(appState.TOKEN_KEY, appState.token);
    else appState.token = window.sessionStorage.getItem(appState.TOKEN_KEY);
  } catch {
    appState.storageUnavailable = true;
  }
  if (appState.token && !/^[a-f0-9]+$/i.test(appState.token)) appState.token = null;
  window.history.replaceState(window.history.state, "", appState.launch.url);
  appState.committedUrl = appState.launch.url.href;
  authenticationSession.reset();
  onApplicationDispose(() => authenticationSession.reset());
  appState.authenticationRecovery = null;
  appState.authSetup = false;
  appState.authenticating = false;
  appState.connectionState = "connecting";
  appState.currentRoot = null;
  appState.currentPort = null;
  documentSession.close();
  onApplicationDispose(() => documentSession.close());
  appState.creating = false;
  appState.newNoteOrigin = null;
  appState.newItemParent = "";
  appState.contextFile = null;
  appState.movingEntry = false;
  appState.draggedEntry = null;
  appState.dropTarget = null;
  libraryModel.reset();
  onApplicationDispose(() => libraryModel.reset());
  appState.previewTimer = null;
  appState.previewController = null;
  appState.renderedPreviewDocument = null;
  appState.renderedPreviewRevision = -1;
  appState.connectionController = null;
  appState.treeController = null;
  appState.copyTimer = null;
  appState.deferredControlTimer = null;
  appState.outlineTimer = null;
  appState.outlineChanges = null;
  appState.appearanceController = null;
  appState.appearanceTimer = null;
  appState.appearanceGeneration = 0;
  appState.connectionGate = new RequestGate();
  appState.treeGate = new RequestGate();
  appState.previewGate = new RequestGate();
  appState.inlineEditorPath = null;
  onApplicationDispose(() => {
    for (const controller of [
      appState.connectionController,
      appState.treeController,
      appState.previewController,
      appState.appearanceController,
    ])
      controller?.abort();
    for (const timer of [
      appState.copyTimer,
      appState.deferredControlTimer,
      appState.outlineTimer,
      appState.previewTimer,
      appState.appearanceTimer,
    ])
      clearTimer(timer);
    for (const gate of [appState.connectionGate, appState.treeGate, appState.previewGate]) gate.invalidate();
  });
}
export function rootChanged() {
  return Boolean(documentSession.current && documentSession.current.root !== appState.currentRoot);
}
export function currentEditorAnalysis() {
  return documentSession.analyze(appState.ui.editor.value);
}
export function dirty() {
  return currentEditorAnalysis().changed;
}
function createApplicationUi() {
  const nodes = {
    appShell: appState.element("app-shell"),
    authScreen: appState.element("auth-screen"),
    authForm: appState.element("auth-form"),
    authTitle: appState.element("auth-title"),
    authUsername: appState.element("auth-username"),
    authPassword: appState.element("auth-password"),
    authConfirmField: appState.element("auth-confirm-field"),
    authConfirm: appState.element("auth-confirm"),
    authError: appState.element("auth-error"),
    authSubmit: appState.element("auth-submit"),
    commandOpen: appState.element("command-palette-open"),
    commandDialog: appState.element("command-dialog"),
    commandForm: appState.element("command-form"),
    commandQuery: appState.element("command-query"),
    commandList: appState.element("command-list"),
    commandEmpty: appState.element("command-empty"),
    commandClose: appState.element("command-close"),
    settingsOpen: appState.element("settings-open"),
    settingsDialog: appState.element("settings-dialog"),
    settingsForm: appState.element("settings-form"),
    settingsClose: appState.element("settings-close"),
    settingsCancel: appState.element("settings-cancel"),
    settingsSearch: appState.element("settings-search"),
    settingsHiddenPatterns: appState.element("hidden-patterns"),
    settingsPageWidth: appState.element("settings-page-width"),
    settingsSidebarWidth: appState.element("settings-sidebar-width"),
    settingsSidebarValue: appState.element("settings-sidebar-value"),
    settingsCommandShortcut: appState.element("settings-command-shortcut"),
    settingsError: appState.element("settings-error"),
    logout: appState.element("logout"),
    connectionLabel: appState.element("connection-label"),
    connectionMessage: appState.element("connection-message"),
    appearanceMessage: appState.element("appearance-message"),
    reconnect: appState.element("reconnect"),
    newNote: appState.element("new-note"),
    newFolder: appState.element("new-folder"),
    refreshFiles: appState.element("refresh-files"),
    filter: appState.element("file-filter"),
    treeMessage: appState.element("tree-message"),
    treeLimit: appState.element("tree-limit"),
    fileNav: appState.element("file-nav"),
    fileList: appState.element("file-list"),
    title: appState.element("document-name"),
    modified: appState.element("document-modified"),
    viewLabel: appState.element("view-label"),
    dirty: appState.element("dirty-indicator"),
    reload: appState.element("reload-document"),
    copy: appState.element("copy-text"),
    copyStatus: appState.element("copy-status"),
    conflictMessage: appState.element("conflict-message"),
    rootWarning: appState.element("root-warning"),
    documentMessage: appState.element("document-message"),
    loadingMessage: appState.element("loading-message"),
    sizeWarning: appState.element("size-warning"),
    panes: appState.element("document-panes"),
    editor: appState.element("editor"),
    stats: appState.element("editor-stats"),
    preview: appState.element("preview"),
    previewStatus: appState.element("preview-status"),
    newDialog: appState.element("new-note-dialog"),
    newForm: appState.element("new-note-form"),
    newTitle: appState.element("new-note-title"),
    newNoteHint: appState.element("new-note-hint"),
    newError: appState.element("new-note-error"),
    cancelNew: appState.element("cancel-new-note"),
    create: appState.element("create-note"),
    newFolderDialog: appState.element("new-folder-dialog"),
    newFolderForm: appState.element("new-folder-form"),
    newFolderPath: appState.element("new-folder-path"),
    newFolderError: appState.element("new-folder-error"),
    cancelNewFolder: appState.element("cancel-new-folder"),
    createFolder: appState.element("create-folder"),
    fileContextMenu: appState.element("file-context-menu"),
    fileDetails: appState.element("file-details"),
    fileRename: appState.element("file-rename"),
    renameDialog: appState.element("rename-dialog"),
    renameForm: appState.element("rename-form"),
    renamePath: appState.element("rename-path"),
    renameError: appState.element("rename-error"),
    cancelRename: appState.element("cancel-rename"),
    confirmRename: appState.element("confirm-rename"),
    detailsDialog: appState.element("details-dialog"),
    detailsName: appState.element("details-name"),
    detailsMetadataTitle: appState.element("details-metadata-title"),
    detailsPath: appState.element("details-path"),
    detailsSize: appState.element("details-size"),
    detailsModified: appState.element("details-modified"),
    closeDetails: appState.element("close-details"),
    empty: appState.element("empty-document"),
    emptyNew: appState.element("empty-new-note"),
    libraryHeading: document.querySelector(".library-heading"),
    sidebar: appState.element("sidebar"),
    sidebarResizer: appState.element("sidebar-resizer"),
    sidebarToggle: appState.element("sidebar-toggle"),
    scrim: appState.element("sidebar-scrim"),
    filesTab: appState.element("files-tab"),
    outlineTab: appState.element("outline-tab"),
    filesPanel: appState.element("files-panel"),
    outlinePanel: appState.element("outline-panel"),
    outlineNavigation: appState.element("document-outline"),
    outlineRail: appState.element("outline-rail"),
    outlineList: appState.element("outline-list"),
    outlineEmpty: appState.element("outline-empty"),
    focusMode: appState.element("focus-mode"),
  };
  const editorHost = nodes.editor.parentElement;
  const previewHost = nodes.preview.parentElement;
  if (!editorHost || !previewHost) throw new Error("The document editors require their scroll containers.");
  const scrollbars = [
    ownApplicationResource(
      attachScrollbars(appState.element("files-scroll-frame"), nodes.fileNav, { horizontal: false }),
    ),
    ownApplicationResource(
      attachScrollbars(appState.element("outline-scroll-frame"), appState.element("outline-scroll"), {
        horizontal: false,
      }),
    ),
    ownApplicationResource(attachScrollbars(editorHost, nodes.editor)),
    ownApplicationResource(attachScrollbars(previewHost, nodes.preview)),
  ];
  const editor = ownApplicationResource(
    createSourceEditor({
      textarea: appState.element("editor"),
      nonce: requiredQuery(document, 'meta[name="folio-style-nonce"]', HTMLMetaElement).content,
      onNotice: (message) => notice(appState.element("document-message"), message, "error"),
    }),
  );
  return { ...nodes, editor, scrollbars };
}
