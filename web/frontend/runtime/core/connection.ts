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
import { clearServiceOutage } from "./recovery";
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
      clearServiceOutage();
      refreshControls();
      return;
    }
    if (!current()) return;
    selected = projectModel.selection;
    const projectRequest = projectModel.request();
    const [session] = await Promise.all([
      api("/api/session", { decode: decodedSession, method: "POST", signal, timeoutMs: 15000 }),
      refreshSharedPreferences(signal),
    ]);
    if (!current()) return;
    if (!session || typeof session.root !== "string" || !Number.isInteger(session.port)) {
      throw new ApiError("Incomplete session settings");
    }
    appState.currentPort = session.port;
    if (session.project) projectModel.acceptSession(projectRequest, session.project);
    appState.connectionState = "ready";
    clearServiceOutage();
    setRoot(session.root);
    const tokenStorageUnavailable = authenticationSession.mode === "launchToken" && appState.storageUnavailable;
    notice(
      appState.ui.connectionMessage,
      tokenStorageUnavailable ? "Connection token not stored" : "",
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
          throw new ApiError("Unexpected note in response");
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
        if (access.version !== retained.version) documentNotice("File changed on disk", "warning");
        refreshControls();
      }
      scheduleAutoSave();
      schedulePreview(0);
    } else {
      const route = readNoteRoute(window.location.href);
      if (route.id) void navigateTo(route.id, route.hash, { mode: "replace", url: new URL(window.location.href) });
      else previewStatus("Select a note");
    }
  } catch (errorCause) {
    const error = errorContext(errorCause);
    if (!current() || aborted(error)) return;
    connectionFailure(error, true);
    renderTreeStatus();
  } finally {
    if (current()) {
      appState.connectionController = null;
      refreshControls();
    }
  }
}
