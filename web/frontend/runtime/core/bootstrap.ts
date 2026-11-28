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
import {
  RequestGate,
  clearPageCodes,
  createWordCounter,
  expandedPageUrl,
  readLaunchUrl,
  type DocumentSessionId,
} from "@folio/model";
import type { Heading, InlineEditor } from "../../types/domain";
import { clearElements, clearTimer, element, requiredQuery } from "../../types/elements";
import { notice } from "./notice";
import { onApplicationDispose, ownApplicationResource } from "../lifecycle";
class AppState {
  editor = initializeEditors();
  compactLayout = window.matchMedia("(max-width: 650px)");
  SIDEBAR_WIDTH_KEY = "folio.layout.sidebarWidth";
  SIDEBAR_STATE_KEY = "folio.layout.sidebarState";
  PAGE_WIDTH_KEY = "folio.layout.pageWidth";
  COMMAND_SHORTCUT_KEY = "folio.shortcuts.commandPanel";
  HIDDEN_PATTERNS_KEY = "folio.library.hiddenPatterns";
  SIDEBAR_MIN = 210;
  SIDEBAR_MAX = 420;
  SIDEBAR_DEFAULT = 240;
  pageWidths = new Set(["focused", "balanced", "wide"]);
  outlineItems: Heading[] = [];
  outlineSource: string | null = null;
  outlineButtons: HTMLButtonElement[] = [];
  outlineById = new Map<string, HTMLButtonElement>();
  currentOutlineButton: HTMLButtonElement | null = null;
  focusAfterLoad = false;
  pendingHeading: string | number | null = null;
  sidebarBeforeFocus = true;
  wordSource: string | null = null;
  wordCount = 0;
  wordCounter = createWordCounter();
  TOKEN_KEY = "folio.connection.token";
  launch = readLaunchUrl(window.location.href);
  token: string | null = this.launch.token;
  storageUnavailable = false;
  committedUrl!: string;
  authenticationRecovery: {
    id: DocumentSessionId;
    resource?: string;
    participant: string | null;
    ready: boolean;
  } | null = null;
  authSetup = false;
  authenticating = false;
  connectionState = "connecting";
  currentRoot: string | null = null;
  currentPort: number | null = null;
  creating = false;
  newNoteOrigin: {
    id: DocumentSessionId;
    revision: number;
    root: string | null;
  } | null = null;
  newItemParent = "";
  contextFile: {
    path: string;
    kind: "file" | "directory";
  } | null = null;
  movingEntry = false;
  previewTimer: number | null = null;
  previewController: AbortController | null = null;
  renderedPreviewDocument: DocumentSessionId | null = null;
  renderedPreviewRevision = -1;
  connectionController: AbortController | null = null;
  treeController: AbortController | null = null;
  copyTimer: number | null = null;
  deferredControlTimer: number | null = null;
  outlineTimer: number | null = null;
  outlineChanges: SourceChanges | null = null;
  appearanceController: AbortController | null = null;
  appearanceTimer: number | null = null;
  appearanceGeneration = 0;
  connectionGate = new RequestGate();
  treeGate = new RequestGate();
  previewGate = new RequestGate();
  inlineEditorPath: string | null = null;
  outlineExtractor!: ReturnType<typeof createOutlineExtractor>;
  inlineEditor!: InlineEditor;
  preferredSidebarWidth!: number;
  commandShortcut!: string;
}
export let appState: AppState;

export function initializeCoreBootstrap(): void {
  clearElements();
  onApplicationDispose(clearElements);
  clearPageCodes();
  hydrateIcons(document);
  appState = new AppState();
  try {
    if (appState.token) window.sessionStorage.setItem(appState.TOKEN_KEY, appState.token);
    else appState.token = window.sessionStorage.getItem(appState.TOKEN_KEY);
  } catch {
    appState.storageUnavailable = true;
  }
  if (appState.token && !/^[a-f0-9]+$/i.test(appState.token)) appState.token = null;
  window.history.replaceState(window.history.state, "", appState.launch.url);
  appState.committedUrl = expandedPageUrl(appState.launch.url).href;
  authenticationSession.reset();
  onApplicationDispose(() => authenticationSession.reset());
  documentSession.close();
  onApplicationDispose(() => documentSession.close());
  libraryModel.reset();
  onApplicationDispose(() => libraryModel.reset());
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
  return documentSession.analyze(appState.editor.value);
}
export function dirty() {
  return currentEditorAnalysis().changed;
}
function initializeEditors() {
  const textarea = element("editor");
  const preview = element("preview");
  const editorHost = textarea.parentElement;
  const previewHost = preview.parentElement;
  if (!editorHost || !previewHost) throw new Error("The document editors require their scroll containers.");
  ownApplicationResource(
    // A horizontal sidebar drag rarely changes the vertical thumb. Coalesce its measurements,
    // not the resize itself; scrolling and tree mutations keep their normal update cadence.
    attachScrollbars(element("files-scroll-frame"), element("file-nav"), {
      horizontal: false,
      resizeDebounce: [80, 200],
    }),
  );
  ownApplicationResource(
    attachScrollbars(element("outline-scroll-frame"), element("outline-scroll"), {
      horizontal: false,
    }),
  );
  ownApplicationResource(attachScrollbars(editorHost, textarea));
  ownApplicationResource(attachScrollbars(previewHost, preview));
  return ownApplicationResource(
    createSourceEditor({
      textarea,
      nonce: requiredQuery(document, 'meta[name="folio-style-nonce"]', HTMLMetaElement).content,
      onNotice: (message) => notice(element("document-message"), message, "error"),
    }),
  );
}
