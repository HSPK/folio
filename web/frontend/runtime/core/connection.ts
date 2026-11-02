import { projectModel } from "../../state/projects";
import { authenticationSession } from "../../state/authentication";
import { documentSession } from "../../state/document";
import { libraryModel } from "../../state/library";
import { decodedDocument, decodedSession } from "../../api/contracts";
import { readNoteRoute } from "@folio/model";
import { errorContext } from "../../types/errors";
import { connectionFailure, expectDocument, refreshControls, setRoot } from "../accounts/authentication";
import {
  participationState,
  pollDocumentParticipation,
  startDocumentParticipation,
} from "../collaboration/participation";
import { cancelDocumentLoad, navigateTo } from "../documents/navigation";
import { invalidatePreview, schedulePreview } from "../documents/preview";
import { acceptDocumentPermissions } from "../documents/resources";
import { scheduleAutoSave } from "../documents/saving";
import { applicationSignal } from "../lifecycle";
import { refreshFiles, renderTreeStatus } from "../navigation/library";
import { refreshSharedPreferences } from "../preferences/settings";
import { ensureProject } from "../projects/projects";
import { connectPublic, publicState } from "../sharing/public";
import { restoreActiveWorkspaceNote } from "../workspace/workspace";
import { api } from "./api";
import { refreshAppearance, stopAppearancePolling } from "./appearance";
import { appState } from "./bootstrap";
import { ApiError, aborted, documentNotice, notice, previewStatus } from "./dom";

export async function connect({ restoreWorkspace = true }: { restoreWorkspace?: boolean } = {}): Promise<void> {
  if (publicState.publicView) {
    await connectPublic();
    return;
  }
  const owner = applicationSignal();
  const scope = authenticationSession.scope;
  if (scope.signal.aborted) return;
  if (restoreWorkspace) restoreActiveWorkspaceNote();
  stopAppearancePolling();
  appState.connectionController?.abort();
  appState.treeController?.abort();
  appState.treeGate.invalidate();
  libraryModel.update({ loading: false });
  cancelDocumentLoad();
  invalidatePreview();
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, scope.signal, owner]);
  appState.connectionController = controller;
  const ticket = appState.connectionGate.next();
  let selected: symbol | undefined;
  const current = () =>
    !owner.aborted &&
    authenticationSession.isCurrent(scope) &&
    appState.connectionGate.isCurrent(ticket) &&
    (selected === undefined || selected === projectModel.selection);
  appState.connectionState = "connecting";
  notice(appState.ui.connectionMessage, "");
  refreshControls();
  try {
    if (!(await ensureProject(current))) {
      if (!current()) return;
      refreshControls();
      return;
    }
    if (!current()) return;
    selected = projectModel.selection;
    const projectRequest = projectModel.request();
    const [session] = await Promise.all([
      api("/api/session", { decode: decodedSession, method: "POST", signal }),
      refreshSharedPreferences(signal),
    ]);
    if (!current()) return;
    if (!session || typeof session.root !== "string" || !Number.isInteger(session.port)) {
      throw new ApiError("The service returned incomplete session settings.");
    }
    appState.currentPort = session.port;
    if (session.project) projectModel.acceptSession(projectRequest, session.project);
    appState.connectionState = "ready";
    setRoot(session.root);
    const tokenStorageUnavailable = authenticationSession.mode === "launchToken" && appState.storageUnavailable;
    notice(
      appState.ui.connectionMessage,
      tokenStorageUnavailable
        ? "This browser could not store the connection token for this tab. Copy unsaved work before refreshing; you may need to reopen Folio using the app or CLI launch URL."
        : "",
      tokenStorageUnavailable ? "warning" : "",
    );
    refreshControls();
    void refreshAppearance(true);
    void refreshFiles();
    if (documentSession.current) {
      if (authenticationSession.mode === "users") {
        const retained = documentSession.current;
        const id = documentSession.id;
        const access = expectDocument(
          await api(`/api/document?id=${encodeURIComponent(retained.id)}&render=source`, {
            decode: decodedDocument,
            signal,
          }),
        );
        if (!current() || documentSession.current !== retained || documentSession.id !== id) return;
        if (access.id !== retained.id || access.project !== retained.project)
          throw new ApiError("The service returned a different note while refreshing access.");
        acceptDocumentPermissions(access.permissions);
        if (!participationState.documentParticipation) {
          const recovery =
            appState.authenticationRecovery?.id === id && appState.authenticationRecovery.resource === retained.id
              ? appState.authenticationRecovery
              : null;
          await startDocumentParticipation({
            participant: recovery?.participant ?? null,
            ready: recovery?.ready ?? false,
          });
        } else await pollDocumentParticipation();
        if (!current() || documentSession.current !== retained || documentSession.id !== id) return;
        appState.authenticationRecovery = null;
        if (access.version !== retained.version)
          documentNotice("The file changed on disk. Local text is kept; saving will check for conflicts.", "warning");
        refreshControls();
      }
      scheduleAutoSave();
      schedulePreview(0);
    } else {
      const route = readNoteRoute(window.location.href);
      if (route.id) void navigateTo(route.id, route.hash, { mode: "replace", url: new URL(window.location.href) });
      else previewStatus("Select a note to begin");
    }
  } catch (errorCause) {
    const error = errorContext(errorCause);
    if (!current() || aborted(error)) return;
    connectionFailure(error, true);
    previewStatus(
      documentSession.current
        ? "Disconnected. Your editor text and last preview are kept."
        : "Open Folio using the app or CLI launch URL to connect",
      true,
    );
    renderTreeStatus();
  } finally {
    if (current()) {
      appState.connectionController = null;
      refreshControls();
    }
  }
}
