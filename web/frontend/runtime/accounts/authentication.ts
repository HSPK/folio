import { authenticationSession } from "../../state/authentication";
import { documentSession } from "../../state/document";
import { libraryCatalog, libraryModel } from "../../state/library";
import { decodedAuthStatus, decodedAuthentication } from "../../api/contracts";
import {
  MAX_MARKDOWN_BYTES,
  browserDocumentTitle,
  formatByteCount,
  noteDisplayTitle,
  readNoteRoute,
} from "@folio/model";
import { updateShell } from "../../state/shell";
import { element, clearTimer, requiredQuery } from "../../types/elements";
import { errorContext, type RuntimeError } from "../../types/errors";
import { isDocumentPayload } from "../../types/guards";
import {
  collaborationLocked,
  collaboration,
  pauseCollaboration,
  stopCollaboration,
} from "../collaboration/collaboration";
import { documentParticipation, stopDocumentParticipation } from "../collaboration/participation";
import { api } from "../core/api";
import { stopAppearancePolling } from "../core/appearance";
import { appState, currentEditorAnalysis, rootChanged } from "../core/bootstrap";
import { ApiError, documentNotice, notice, previewStatus, setText } from "../core/dom";
import { connect } from "../core/connection";
import { finishStartupReads } from "../core/startup";
import { readLayoutPreference, storeLayoutPreference } from "../core/layout";
import {
  clearServiceOutage,
  connectivity,
  initializeConnectionRecovery,
  isConnectionLoss,
  reportServiceOutage,
} from "../core/recovery";
import { closeAllDialogs } from "../dialogs/dialogs";
import { persistCurrentDraft } from "../documents/drafts";
import { cancelDocumentLoad, clearDocument, confirmDiscard } from "../documents/navigation";
import { invalidatePreview, schedulePreview } from "../documents/preview";
import { acceptDocumentPermissions } from "../documents/resources";
import { cancelAutoSave, notifyDocumentSave } from "../documents/saving";
import { libraryState, renderFiles } from "../navigation/library";
import { closeDocumentOutline, openDocumentOutline, refreshOutline } from "../navigation/outline";
import { updateProjectControls } from "../projects/projects";
import { projectCanCreate, projectWritable } from "../projects/permissions";
import { connectPublic, publicState } from "../sharing/public";
import { refreshWorkspaceControls } from "../workspace/controls";
import { loadUserWorkspace } from "../workspace/workspace";
import { applicationSignal } from "../lifecycle";
let authInvitation: boolean;

export function initializeAccountsAuthentication(): void {
  authInvitation = false;
  initializeConnectionRecovery(
    () => (authenticationSession.mode ? connect({ restoreWorkspace: false }) : bootstrapAuthentication()),
    () => {
      if (element("auth-screen").hidden && !element("public-password-dialog").open) {
        connectionFailure(errorContext(new ApiError("Disconnected", 0, true)));
      }
    },
  );
}
export function expectDocument(payload: unknown) {
  if (!isDocumentPayload(payload)) {
    throw new ApiError("Incomplete document");
  }
  return payload;
}
export function handleAuthenticationFailure(error: RuntimeError) {
  if (publicState.publicView || authenticationSession.mode !== "users" || error.status !== 401) return false;
  if (
    error.authenticationGeneration !== undefined &&
    error.authenticationGeneration !== authenticationSession.generation
  )
    return true;
  if (authenticationSession.expired || document.body.dataset.auth === "open") return true;
  if (!authenticationSession.expire(error.authenticationGeneration)) return true;
  appState.authenticationRecovery = documentSession.current
    ? {
        id: documentSession.id,
        resource: documentSession.current.id,
        participant: documentParticipation?.participant ?? null,
        ready: documentParticipation?.ready ?? false,
      }
    : null;
  appState.connectionState = "error";
  cancelAutoSave();
  stopAppearancePolling();
  appState.connectionController?.abort();
  appState.connectionController = null;
  appState.connectionGate.invalidate();
  cancelDocumentLoad();
  appState.treeController?.abort();
  appState.treeController = null;
  appState.treeGate.invalidate();
  libraryModel.update({ loading: false });
  clearTimer(libraryState.treeRefreshTimer);
  libraryState.treeRefreshTimer = null;
  invalidatePreview();
  if (documentSession.current && !collaboration) void persistCurrentDraft().catch(console.error);
  stopDocumentParticipation({ notify: false });
  pauseCollaboration();
  if (documentSession.current) acceptDocumentPermissions({ writable: false, collaborative: false, owner: false });
  showAuthentication(false, "Log in again");
  return true;
}
export function connectionFailure(error: RuntimeError, force = false): void {
  if (handleAuthenticationFailure(error)) return;
  if (isConnectionLoss(error)) {
    if (!element("auth-screen").hidden || element("public-password-dialog").open) return;
    appState.connectionState = "error";
    reportServiceOutage();
    refreshControls();
    return;
  }
  if (force) clearServiceOutage();
  if ((authenticationSession.mode === "users" || publicState.publicView) && error.status === 403) {
    if (force) appState.connectionState = "error";
    documentNotice(error.message, "error");
    return;
  }
  let message = "";
  if (error.status === 401 || error.status === 403) {
    message = "Not authorized";
  } else if (force) {
    message = `Connect failed: ${error.message}`;
  }
  if (!message) return;
  appState.connectionState = "error";
  notice(element("connection-message"), message, "error");
  refreshControls();
}
export function showAuthentication(setup: boolean, message = "", registration = false): void {
  clearServiceOutage();
  closeAllDialogs();
  appState.authSetup = setup;
  authInvitation = !setup && registration;
  appState.connectionState = "error";
  document.body.dataset.auth = "open";
  element("app-shell").inert = true;
  element("auth-screen").hidden = false;
  setText(
    element("auth-title"),
    setup ? "Create the administrator" : authInvitation ? "Create your account" : "Log in to Folio",
  );
  element("auth-invitation-field").hidden = !authInvitation;
  element("auth-invitation").required = authInvitation;
  element("auth-use-invitation").hidden = setup || authInvitation;
  element("auth-back-login").hidden = !authInvitation;
  element("auth-confirm-field").hidden = !(setup || authInvitation);
  requiredQuery(document, "#auth-username-hint", HTMLElement).hidden = !(setup || authInvitation);
  element("auth-confirm").required = setup || authInvitation;
  element("auth-password").autocomplete = setup || authInvitation ? "new-password" : "current-password";
  element("auth-confirm").autocomplete = "new-password";
  notice(element("auth-error"), message, message ? "error" : "");
  setText(element("auth-submit"), setup ? "Create administrator" : authInvitation ? "Create account" : "Log in");
  element("logout").hidden = true;
  refreshControls();
  window.requestAnimationFrame(() => {
    if (authenticationSession.user?.username && !setup)
      element("auth-username").value = authenticationSession.user.username;
    element("auth-username").focus();
  });
}
export function hideAuthentication(): void {
  delete document.body.dataset.auth;
  element("app-shell").inert = false;
  element("auth-screen").hidden = true;
  notice(element("auth-error"), "");
  element("logout").hidden = authenticationSession.mode !== "users" || !authenticationSession.user;
  if (authenticationSession.user) {
    element("logout").textContent = `Log out ${authenticationSession.user.username}`;
  }
}
export async function bootstrapAuthentication(): Promise<void> {
  const owner = applicationSignal();
  const scope = authenticationSession.scope;
  if (publicState.publicView) {
    try {
      await connectPublic();
    } finally {
      finishStartupReads();
    }
    return;
  }
  appState.connectionState = "connecting";
  refreshControls();
  try {
    const status = await api("/api/auth/status", {
      decode: decodedAuthStatus,
      timeoutMs: 15000,
    });
    if (owner.aborted || authenticationSession.scope.key !== scope.key) return;
    authenticationSession.initialize(status.mode, status.user);
    if (authenticationSession.mode === "users") {
      appState.token = null;
      appState.storageUnavailable = false;
      if (status.setupRequired) {
        showAuthentication(true);
        return;
      }
      if (!status.authenticated) {
        showAuthentication(false);
        return;
      }
    } else if (!status.authenticated) {
      throw new ApiError("No valid connection token", 401);
    }
    hideAuthentication();
    const workspace = loadUserWorkspace();
    const restore = !/^\/[np]\//.test(window.location.pathname) && !readNoteRoute(window.location.href).id;
    await connect({ workspace: restore ? workspace : undefined });
  } catch (errorCause) {
    if (owner.aborted) return;
    const error = errorContext(errorCause);
    connectionFailure(error, true);
  } finally {
    finishStartupReads();
  }
}
export async function submitAuthentication(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const owner = applicationSignal();
  if (appState.authenticating) return;
  if ((appState.authSetup || authInvitation) && element("auth-password").value !== element("auth-confirm").value) {
    notice(element("auth-error"), "Passwords do not match", "error");
    element("auth-confirm").focus();
    return;
  }
  appState.authenticating = true;
  const attempt = authenticationSession.beginAuthentication();
  notice(element("auth-error"), "");
  setText(element("auth-submit"), appState.authSetup ? "Creating…" : "Logging in…");
  refreshControls();
  try {
    const result = await api(
      appState.authSetup ? "/api/auth/setup" : authInvitation ? "/api/auth/register" : "/api/auth/login",
      {
        decode: decodedAuthentication,
        method: "POST",
        body: {
          username: element("auth-username").value,
          password: element("auth-password").value,
          ...(authInvitation ? { invitation: element("auth-invitation").value.trim() } : {}),
        },
      },
    );
    if (owner.aborted || authenticationSession.scope.key !== attempt.key) return;
    if (authenticationSession.user && !authenticationSession.sameAccount(result.user)) {
      const pending = persistCurrentDraft();
      stopCollaboration();
      await pending;
      if (owner.aborted) return;
      clearDocument(new URL("/", window.location.href), "replace");
      window.location.replace("/");
      return;
    }
    authenticationSession.authenticate(result.user);
    element("auth-password").value = "";
    element("auth-confirm").value = "";
    element("auth-invitation").value = "";
    hideAuthentication();
    await connect({ workspace: loadUserWorkspace() });
  } catch (errorCause) {
    if (owner.aborted) return;
    const error = errorContext(errorCause);
    if (!(error instanceof ApiError)) console.error("Authentication could not be completed.", error);
    if (appState.authSetup && error.status === 409) {
      appState.authSetup = false;
      showAuthentication(false, "Setup already completed, log in");
    } else {
      notice(element("auth-error"), error.message, "error");
    }
  } finally {
    if (!owner.aborted) {
      appState.authenticating = false;
      setText(
        element("auth-submit"),
        appState.authSetup ? "Create administrator" : authInvitation ? "Create account" : "Log in",
      );
      refreshControls();
    }
  }
}
export async function logout(): Promise<void> {
  if (authenticationSession.mode !== "users" || appState.authenticating || documentSession.saving || appState.creating)
    return;
  if (!(await confirmDiscard("log out"))) return;
  element("logout").disabled = true;
  try {
    await api("/api/auth/logout", { method: "POST" });
    window.location.reload();
  } catch (errorCause) {
    const error = errorContext(errorCause);
    documentNotice(`Logout failed: ${error.message}`, "error");
    connectionFailure(error);
    element("logout").disabled = false;
  }
}
export function setRoot(root: string): void {
  const changed = appState.currentRoot !== null && appState.currentRoot !== root;
  if (changed) {
    libraryModel.reset(true);
    renderFiles();
    invalidatePreview();
  }
  appState.currentRoot = root;
  refreshControls();
  if (changed && documentSession.current) {
    if (rootChanged()) previewStatus("Preview paused: folder changed", true);
    else schedulePreview(0);
  }
}
export function refreshDocumentTitle(modified = !element("document-modified").hidden): void {
  updateShell({ title: documentSession.current ? noteDisplayTitle(documentSession.current) : "Select a note" });
  const title = browserDocumentTitle(documentSession.current, modified);
  if (document.title !== title) document.title = title;
}
export function renderDocumentStatus(changed: boolean): void {
  let state = "empty";
  let status = "";
  if (documentSession.current) {
    state = documentSession.conflict
      ? "conflict"
      : documentSession.saving || collaboration?.saving
        ? "saving"
        : changed
          ? "dirty"
          : "saved";
    status = documentSession.conflict
      ? ""
      : documentSession.saving || collaboration?.saving
        ? "Saving…"
        : projectWritable()
          ? ""
          : "Read only";
  }
  element("dirty-indicator").dataset.state = state;
  setText(element("dirty-indicator"), status);
  element("dirty-indicator").hidden = !status;
  const modified = Boolean(documentSession.current && (changed || !documentSession.resourceId));
  updateShell({ modified });
  refreshDocumentTitle(modified);
}
export function scheduleControlRefresh(delay = 180): void {
  clearTimer(appState.deferredControlTimer);
  appState.deferredControlTimer = window.setTimeout(() => {
    appState.deferredControlTimer = null;
    refreshControls();
  }, delay);
}
export function refreshControls(): void {
  clearTimer(appState.deferredControlTimer);
  appState.deferredControlTimer = null;
  const analysis = currentEditorAnalysis();
  const changed = analysis.changed;
  const ready = appState.connectionState === "ready";
  const writing = Boolean(documentSession.saving || appState.creating || appState.movingEntry);
  const tooLarge = analysis.bytes > MAX_MARKDOWN_BYTES;
  appState.editor.disabled = !documentSession.current || collaborationLocked();
  appState.editor.setReadOnly(!projectWritable());
  appState.inlineEditor.setReadOnly(!projectWritable() || collaborationLocked());
  element("reload-document").disabled = !documentSession.resourceId || writing || !ready;
  element("conflict-latest").disabled = element("reload-document").disabled;
  element("copy-text").disabled = !documentSession.current;
  element("new-note").disabled = !appState.currentRoot || !libraryCatalog.loaded || !projectCanCreate();
  element("new-folder").disabled = element("new-note").disabled;
  element("new-from-template").disabled = element("new-note").disabled;
  element("file-list").toggleAttribute("data-can-add", !element("new-note").disabled);
  element("empty-new-note").disabled = element("new-note").disabled;
  updateShell({ hasDocument: Boolean(documentSession.current) });
  element("logout").disabled = appState.authenticating || writing || appState.connectionState === "connecting";
  element("auth-username").disabled = appState.authenticating;
  element("auth-password").disabled = appState.authenticating;
  element("auth-confirm").disabled = appState.authenticating;
  element("auth-submit").disabled = appState.authenticating;
  element("new-note-title").disabled = appState.creating;
  element("new-note-template").disabled = appState.creating;
  element("cancel-new-note").disabled = appState.creating;
  element("create-note").disabled = appState.creating;
  setText(element("create-note"), appState.creating ? "Creating…" : "Create note");
  const disconnected = connectivity.serviceLost || connectivity.roomLost;
  element("connection-label").dataset.state = disconnected ? "error" : appState.connectionState;
  element("connection-label").classList.toggle("is-error", disconnected);
  element("connection-label").hidden = !disconnected;
  setText(
    element("connection-label"),
    disconnected
      ? "Disconnected"
      : ready
        ? "Local service"
        : appState.connectionState === "connecting"
          ? "Connecting…"
          : "Disconnected",
  );
  element("connection-label").title =
    ready && appState.currentPort ? `Connected on loopback port ${appState.currentPort}` : "";
  if (documentSession.current) {
    const ending =
      documentSession.current.format.lineEnding === "\r\n"
        ? "CRLF"
        : documentSession.current.format.lineEnding === "\r"
          ? "CR"
          : "LF";
    if (appState.wordSource !== appState.editor.value) {
      appState.wordSource = appState.editor.value;
      appState.wordCount = appState.wordCounter.count(appState.wordSource);
    }
    updateShell({
      statistics: `${appState.wordCount.toLocaleString()} ${appState.wordCount === 1 ? "word" : "words"}`,
      statisticsDetail: `${analysis.lines.toLocaleString()} lines · ${formatByteCount(analysis.bytes)} · ${ending}${documentSession.current.format.bom ? " · BOM" : ""}`,
    });
  } else {
    updateShell({ statistics: "", statisticsDetail: "" });
  }
  renderDocumentStatus(changed);
  appState.editor.setAttribute("aria-invalid", String(tooLarge));
  notice(
    element("size-warning"),
    tooLarge ? `${formatByteCount(analysis.bytes)} exceeds the 4 MiB limit` : "",
    "error",
  );
  notice(element("root-warning"), rootChanged() ? "Notes folder changed" : "", "warning");
  refreshOutline();
  updateProjectControls();
  refreshWorkspaceControls();
  notifyDocumentSave();
}
export function selectNavigation(destination: unknown): void {
  if (destination === "outline") {
    openDocumentOutline({ pin: true });
    return;
  }
  closeDocumentOutline();
}
export function restoreSidebar(fallback = !appState.compactLayout.matches): void {
  if (document.body.dataset.focus === "true") return;
  const saved = readLayoutPreference(appState.SIDEBAR_STATE_KEY);
  setSidebar(saved === "open" ? true : saved === "closed" ? false : fallback);
}
export function setSidebar(open: boolean, persist = false): void {
  if (publicState.publicView) open = false;
  const returnFocus =
    !open &&
    (element("sidebar").contains(document.activeElement) || document.activeElement === element("sidebar-toggle"));
  const openingFromToggle = open && document.activeElement === element("sidebar-toggle");
  document.body.dataset.sidebar = open ? "open" : "closed";
  updateShell({ sidebarOpen: open, compact: appState.compactLayout.matches });
  if (persist && !publicState.publicView) storeLayoutPreference(appState.SIDEBAR_STATE_KEY, open ? "open" : "closed");
  if (!open) element("new-menu-panel").hidePopover();
  element("sidebar-resizer").tabIndex = open && !appState.compactLayout.matches ? 0 : -1;
  if (returnFocus && !publicState.publicView) element("sidebar-toggle").focus({ preventScroll: true });
  if (openingFromToggle) element("sidebar-hide").focus({ preventScroll: true });
}
export function closeMenus(): void {
  for (const popup of document.querySelectorAll<HTMLElement>(".popup-panel:popover-open")) popup.hidePopover();
}
export function toggleFocusMode(): void {
  if (publicState.publicView) return;
  const enabled = document.body.dataset.focus !== "true";
  if (enabled) appState.sidebarBeforeFocus = document.body.dataset.sidebar === "open";
  document.body.dataset.focus = String(enabled);
  element("focus-mode").setAttribute("aria-pressed", String(enabled));
  setSidebar(enabled ? false : appState.sidebarBeforeFocus);
  closeDocumentOutline();
  closeMenus();
}
