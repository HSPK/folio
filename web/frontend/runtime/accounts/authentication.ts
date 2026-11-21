import { authenticationSession } from "../../state/authentication";
import { documentSession } from "../../state/document";
import { libraryModel } from "../../state/library";
import { decodedAuthStatus, decodedAuthentication } from "../../api/contracts";
import { MAX_MARKDOWN_BYTES, browserDocumentTitle, formatByteCount, readNoteRoute } from "@folio/model";
import { updateShell } from "../../state/shell";
import { clearTimer } from "../../types/elements";
import { errorContext, type RuntimeError } from "../../types/errors";
import { isDocumentPayload } from "../../types/guards";
import {
  collaborationLocked,
  collaborationState,
  pauseCollaboration,
  stopCollaboration,
} from "../collaboration/collaboration";
import { participationState, stopDocumentParticipation } from "../collaboration/participation";
import { api } from "../core/api";
import { stopAppearancePolling } from "../core/appearance";
import { appState, currentEditorAnalysis, rootChanged } from "../core/bootstrap";
import { ApiError, documentNotice, notice, previewStatus, setText } from "../core/dom";
import { connect } from "../core/connection";
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
import { renameChanged } from "../navigation/files";
import { libraryState, renderFiles } from "../navigation/library";
import { closeDocumentOutline, openDocumentOutline, refreshOutline } from "../navigation/outline";
import { updateProjectControls } from "../projects/projects";
import { projectCanCreate, projectWritable } from "../projects/permissions";
import { connectPublic, publicState } from "../sharing/public";
import { refreshWorkspaceControls } from "../workspace/controls";
import { loadUserWorkspace } from "../workspace/workspace";
import { applicationSignal } from "../lifecycle";
class AuthenticationState {
  authInvitation!: boolean;
}
export const authenticationState = new AuthenticationState();
export function initializeAccountsAuthentication(): void {
  authenticationState.authInvitation = false;
  initializeConnectionRecovery(
    () => (authenticationSession.mode ? connect({ restoreWorkspace: false }) : bootstrapAuthentication()),
    () => {
      if (appState.ui.authScreen.hidden && !appState.element("public-password-dialog").open) {
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
        participant: participationState.documentParticipation?.participant ?? null,
        ready: participationState.documentParticipation?.ready ?? false,
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
  if (documentSession.current && !collaborationState.collaboration) void persistCurrentDraft().catch(console.error);
  stopDocumentParticipation({ notify: false });
  pauseCollaboration();
  if (documentSession.current) acceptDocumentPermissions({ writable: false, collaborative: false, owner: false });
  showAuthentication(false, "Log in again");
  return true;
}
export function connectionFailure(error: RuntimeError, force = false): void {
  if (handleAuthenticationFailure(error)) return;
  if (isConnectionLoss(error)) {
    if (!appState.ui.authScreen.hidden || appState.element("public-password-dialog").open) return;
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
  notice(appState.ui.connectionMessage, message, "error");
  refreshControls();
}
export function showAuthentication(setup: boolean, message = "", registration = false): void {
  clearServiceOutage();
  closeAllDialogs();
  appState.authSetup = setup;
  authenticationState.authInvitation = !setup && registration;
  appState.connectionState = "error";
  document.body.dataset.auth = "open";
  appState.ui.appShell.inert = true;
  appState.ui.authScreen.hidden = false;
  setText(
    appState.ui.authTitle,
    setup ? "Create the administrator" : authenticationState.authInvitation ? "Create your account" : "Log in to Folio",
  );
  appState.element("auth-invitation-field").hidden = !authenticationState.authInvitation;
  appState.element("auth-invitation").required = authenticationState.authInvitation;
  appState.element("auth-use-invitation").hidden = setup || authenticationState.authInvitation;
  appState.element("auth-back-login").hidden = !authenticationState.authInvitation;
  appState.ui.authConfirmField.hidden = !(setup || authenticationState.authInvitation);
  appState.ui.authConfirm.required = setup || authenticationState.authInvitation;
  appState.ui.authPassword.autocomplete =
    setup || authenticationState.authInvitation ? "new-password" : "current-password";
  appState.ui.authConfirm.autocomplete = "new-password";
  notice(appState.ui.authError, message, message ? "error" : "");
  setText(
    appState.ui.authSubmit,
    setup ? "Create administrator" : authenticationState.authInvitation ? "Create account" : "Log in",
  );
  appState.ui.logout.hidden = true;
  refreshControls();
  window.requestAnimationFrame(() => {
    if (authenticationSession.user?.username && !setup)
      appState.ui.authUsername.value = authenticationSession.user.username;
    appState.ui.authUsername.focus();
  });
}
export function hideAuthentication(): void {
  delete document.body.dataset.auth;
  appState.ui.appShell.inert = false;
  appState.ui.authScreen.hidden = true;
  notice(appState.ui.authError, "");
  appState.ui.logout.hidden = authenticationSession.mode !== "users" || !authenticationSession.user;
  if (authenticationSession.user) {
    appState.ui.logout.textContent = `Log out ${authenticationSession.user.username}`;
  }
}
export async function bootstrapAuthentication(): Promise<void> {
  const owner = applicationSignal();
  const scope = authenticationSession.scope;
  if (publicState.publicView) {
    await connectPublic();
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
    if (!readNoteRoute(window.location.href).id) await workspace;
    if (owner.aborted) return;
    await connect();
  } catch (errorCause) {
    if (owner.aborted) return;
    const error = errorContext(errorCause);
    connectionFailure(error, true);
  }
}
export async function submitAuthentication(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const owner = applicationSignal();
  if (appState.authenticating) return;
  if (
    (appState.authSetup || authenticationState.authInvitation) &&
    appState.ui.authPassword.value !== appState.ui.authConfirm.value
  ) {
    notice(appState.ui.authError, "Passwords do not match", "error");
    appState.ui.authConfirm.focus();
    return;
  }
  appState.authenticating = true;
  const attempt = authenticationSession.beginAuthentication();
  notice(appState.ui.authError, "");
  setText(appState.ui.authSubmit, appState.authSetup ? "Creating…" : "Logging in…");
  refreshControls();
  try {
    const result = await api(
      appState.authSetup
        ? "/api/auth/setup"
        : authenticationState.authInvitation
          ? "/api/auth/register"
          : "/api/auth/login",
      {
        decode: decodedAuthentication,
        method: "POST",
        body: {
          username: appState.ui.authUsername.value,
          password: appState.ui.authPassword.value,
          ...(authenticationState.authInvitation
            ? { invitation: appState.element("auth-invitation").value.trim() }
            : {}),
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
    appState.ui.authPassword.value = "";
    appState.ui.authConfirm.value = "";
    appState.element("auth-invitation").value = "";
    hideAuthentication();
    await loadUserWorkspace();
    if (owner.aborted) return;
    await connect();
  } catch (errorCause) {
    if (owner.aborted) return;
    const error = errorContext(errorCause);
    if (!(error instanceof ApiError)) console.error("Authentication could not be completed.", error);
    if (appState.authSetup && error.status === 409) {
      appState.authSetup = false;
      showAuthentication(false, "Setup already completed, log in");
    } else {
      notice(appState.ui.authError, error.message, "error");
    }
  } finally {
    if (!owner.aborted) {
      appState.authenticating = false;
      setText(
        appState.ui.authSubmit,
        appState.authSetup ? "Create administrator" : authenticationState.authInvitation ? "Create account" : "Log in",
      );
      refreshControls();
    }
  }
}
export async function logout(): Promise<void> {
  if (authenticationSession.mode !== "users" || appState.authenticating || documentSession.saving || appState.creating)
    return;
  if (!(await confirmDiscard("log out"))) return;
  appState.ui.logout.disabled = true;
  try {
    await api("/api/auth/logout", { method: "POST" });
    window.location.reload();
  } catch (errorCause) {
    const error = errorContext(errorCause);
    documentNotice(`Logout failed: ${error.message}`, "error");
    connectionFailure(error);
    appState.ui.logout.disabled = false;
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
export function refreshDocumentTitle(modified = !appState.ui.modified.hidden): void {
  updateShell({ title: documentSession.current?.title ?? documentSession.current?.path ?? "Select a note" });
  const title = browserDocumentTitle(documentSession.current, modified);
  if (document.title !== title) document.title = title;
}
export function renderDocumentStatus(changed: boolean): void {
  let state = "empty";
  let status = "";
  if (documentSession.current) {
    state = documentSession.conflict
      ? "conflict"
      : documentSession.saving || collaborationState.collaboration?.saving
        ? "saving"
        : changed
          ? "dirty"
          : "saved";
    status = documentSession.conflict
      ? "Disk conflict"
      : documentSession.saving || collaborationState.collaboration?.saving
        ? "Saving…"
        : projectWritable()
          ? ""
          : "Read only";
  }
  appState.ui.dirty.dataset.state = state;
  setText(appState.ui.dirty, status);
  appState.ui.dirty.hidden = !status;
  const modified = Boolean(documentSession.current && changed);
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
  appState.ui.editor.disabled = !documentSession.current || collaborationLocked();
  appState.ui.editor.setReadOnly(!projectWritable());
  appState.inlineEditor.setReadOnly(!projectWritable() || collaborationLocked());
  appState.ui.reload.disabled = !documentSession.current || writing || !ready;
  appState.ui.copy.disabled = !documentSession.current;
  appState.ui.newNote.disabled = !ready || appState.creating || appState.movingEntry || !projectCanCreate();
  appState.ui.newFolder.disabled = !ready || writing || !projectCanCreate();
  appState.ui.emptyNew.disabled = appState.ui.newNote.disabled;
  updateShell({ hasDocument: Boolean(documentSession.current) });
  appState.ui.logout.disabled = appState.authenticating || writing || appState.connectionState === "connecting";
  appState.ui.authUsername.disabled = appState.authenticating;
  appState.ui.authPassword.disabled = appState.authenticating;
  appState.ui.authConfirm.disabled = appState.authenticating;
  appState.ui.authSubmit.disabled = appState.authenticating;
  appState.ui.newTitle.disabled = appState.creating;
  appState.element("new-note-template").disabled = appState.creating;
  appState.ui.cancelNew.disabled = appState.creating;
  appState.ui.create.disabled = appState.creating;
  appState.ui.newFolderPath.disabled = appState.creating;
  appState.ui.cancelNewFolder.disabled = appState.creating;
  appState.ui.createFolder.disabled = appState.creating;
  appState.ui.renamePath.disabled = appState.movingEntry;
  appState.ui.cancelRename.disabled = appState.movingEntry;
  appState.ui.confirmRename.disabled = appState.movingEntry || !renameChanged();
  setText(appState.ui.create, appState.creating ? "Creating…" : "Create note");
  setText(appState.ui.createFolder, appState.creating ? "Creating…" : "Create folder");
  setText(appState.ui.confirmRename, appState.movingEntry ? "Moving…" : "Rename");
  const disconnected = connectivity.serviceLost || connectivity.roomLost;
  appState.ui.connectionLabel.dataset.state = disconnected ? "error" : appState.connectionState;
  appState.ui.connectionLabel.classList.toggle("is-error", disconnected);
  appState.ui.connectionLabel.hidden = !disconnected;
  setText(
    appState.ui.connectionLabel,
    disconnected
      ? "Disconnected"
      : ready
        ? "Local service"
        : appState.connectionState === "connecting"
          ? "Connecting…"
          : "Disconnected",
  );
  appState.ui.connectionLabel.title =
    ready && appState.currentPort ? `Connected on loopback port ${appState.currentPort}` : "";
  if (documentSession.current) {
    const ending =
      documentSession.current.format.lineEnding === "\r\n"
        ? "CRLF"
        : documentSession.current.format.lineEnding === "\r"
          ? "CR"
          : "LF";
    if (appState.wordSource !== appState.ui.editor.value) {
      appState.wordSource = appState.ui.editor.value;
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
  appState.ui.editor.setAttribute("aria-invalid", String(tooLarge));
  notice(
    appState.ui.sizeWarning,
    tooLarge ? `${formatByteCount(analysis.bytes)} exceeds the 4 MiB limit` : "",
    "error",
  );
  notice(appState.ui.rootWarning, rootChanged() ? "Notes folder changed" : "", "warning");
  refreshOutline();
  updateProjectControls();
  refreshWorkspaceControls();
  notifyDocumentSave();
}
export function selectNavigation(destination: unknown, focus = false): void {
  if (destination === "outline") {
    openDocumentOutline({ pin: true, focus });
    return;
  }
  closeDocumentOutline();
  if (focus) appState.ui.filter.focus();
}
export function setSidebar(open: boolean): void {
  if (publicState.publicView) open = false;
  const returnFocus =
    !open &&
    (appState.ui.sidebar.contains(document.activeElement) || document.activeElement === appState.ui.sidebarToggle);
  const openingFromToggle = open && document.activeElement === appState.ui.sidebarToggle;
  document.body.dataset.sidebar = open ? "open" : "closed";
  updateShell({ sidebarOpen: open, compact: appState.compactLayout.matches });
  appState.ui.sidebarResizer.tabIndex = open && !appState.compactLayout.matches ? 0 : -1;
  if (returnFocus && !publicState.publicView) appState.ui.sidebarToggle.focus({ preventScroll: true });
  if (openingFromToggle) appState.element("sidebar-hide").focus({ preventScroll: true });
}
export function closeMenus(): void {
  for (const popup of document.querySelectorAll<HTMLDetailsElement>(".popup[open]")) popup.open = false;
}
export function toggleFocusMode(): void {
  const enabled = document.body.dataset.focus !== "true";
  if (enabled) appState.sidebarBeforeFocus = document.body.dataset.sidebar === "open";
  document.body.dataset.focus = String(enabled);
  appState.ui.focusMode.setAttribute("aria-pressed", String(enabled));
  setSidebar(enabled ? false : appState.sidebarBeforeFocus);
  closeDocumentOutline();
  closeMenus();
}
