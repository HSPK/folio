import { element } from "../../types/elements";
import { projectModel } from "../../state/projects";
import { authenticationSession } from "../../state/authentication";
import { documentSession } from "../../state/document";
import { libraryModel } from "../../state/library";
import { decodedDocument, decodedSession } from "../../api/contracts";
import { readNoteRoute, isResourceId } from "@folio/model";
import { errorContext } from "../../types/errors";
import { connectionFailure, expectDocument, refreshControls, setRoot } from "../accounts/authentication";
import {
  documentParticipation,
  pollDocumentParticipation,
  startDocumentParticipation,
} from "../collaboration/participation";
import { cancelDocumentLoad, commitUrl, navigateTo, type InitialDocumentRead } from "../documents/navigation";
import { invalidatePreview, schedulePreview } from "../documents/preview";
import { acceptDocumentPermissions, documentReadUrl } from "../documents/resources";
import { scheduleAutoSave } from "../documents/saving";
import { applicationSignal } from "../lifecycle";
import { prepareProjectTree, refreshFiles, renderTreeStatus } from "../navigation/library";
import { resumeLibraryWrites } from "../navigation/creation";
import { openFilePanel, openFilePanelResource } from "../navigation/panels";
import { refreshSharedPreferences } from "../preferences/settings";
import { ensureProject } from "../projects/projects";
import { loadProjectCatalog } from "../projects/gateway";
import { resolvePageRoute } from "../documents/page-route";
import { connectPublic, publicState } from "../sharing/public";
import { activeWorkspaceKey, rememberedFilePanel, restoreActiveWorkspaceNote } from "../workspace/workspace";
import { storeLayoutPreference } from "./layout";
import { api } from "./api";
import { scheduleAppearancePolling, stopAppearancePolling } from "./appearance";
import { appState } from "./bootstrap";
import { clearServiceOutage } from "./recovery";
import { ApiError, aborted, documentNotice, notice, previewStatus } from "./dom";

export async function connect({
  restoreWorkspace = true,
  selectedProject,
  workspace,
}: { restoreWorkspace?: boolean; selectedProject?: symbol; workspace?: Promise<void> } = {}): Promise<void> {
  if (publicState.publicView) {
    await connectPublic();
    return;
  }
  const owner = applicationSignal();
  const scope = authenticationSession.scope;
  if (scope.signal.aborted) return;
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
  notice(element("connection-message"), "");
  refreshControls();
  let prepared: ReturnType<typeof prepareProjectTree> | undefined;
  try {
    // An explicit switch already has a selection. The scoped session and tree still authorize it.
    const catalog =
      authenticationSession.mode === "users" && selectedProject !== projectModel.selection
        ? loadProjectCatalog()
        : Promise.resolve();
    const preferences = refreshSharedPreferences(signal, selectedProject === projectModel.selection);
    void preferences.catch(() => {}); // A canceled or unavailable destination may not consume this read.
    const [resolved] = await Promise.all([
      resolvePageRoute(appState.committedUrl, signal, () => catalog),
      catalog,
      workspace,
    ]);
    if (!current()) return;
    appState.committedUrl = resolved.href;
    if (restoreWorkspace) restoreActiveWorkspaceNote();
    if (!(await ensureProject(current))) {
      if (!current()) return;
      clearServiceOutage();
      refreshControls();
      return;
    }
    if (!current()) return;
    selected = projectModel.selection;
    const projectRequest = projectModel.request();
    const sessionRequest = api("/api/session", { decode: decodedSession, method: "POST", signal, timeoutMs: 15000 });
    const destination = readNoteRoute(appState.committedUrl).id;
    let initialRead: InitialDocumentRead | undefined;
    // Preferences pick the response representation (source vs rendered); the session need not precede the read.
    const prepareNote = preferences.then(() => {
      if (!destination || !current() || documentSession.current) return;
      const url = documentReadUrl(destination);
      const result = api(url, { decode: decodedDocument, signal });
      void result.catch(() => {});
      initialRead = { id: destination, url, result };
    });
    if (!libraryModel.catalog.loaded) prepared = prepareProjectTree(signal);
    const [session] = await Promise.all([sessionRequest, prepareNote]);
    if (!current()) return;
    if (!session || typeof session.root !== "string" || !Number.isInteger(session.port)) {
      throw new ApiError("Incomplete session settings");
    }
    appState.currentPort = session.port;
    if (session.project) projectModel.acceptSession(projectRequest, session.project);
    appState.connectionState = "ready";
    clearServiceOutage();
    setRoot(session.root);
    resumeLibraryWrites();
    const tokenStorageUnavailable = authenticationSession.mode === "launchToken" && appState.storageUnavailable;
    notice(
      element("connection-message"),
      tokenStorageUnavailable ? "Connection token not stored" : "",
      tokenStorageUnavailable ? "warning" : "",
    );
    refreshControls();
    scheduleAppearancePolling();
    void refreshFiles(prepared);
    prepared = undefined;
    const asset = new URL(appState.committedUrl).searchParams.get("asset");
    const remembered = restoreWorkspace ? rememberedFilePanel() : null;
    if (asset || (remembered && remembered.project === (projectModel.active?.id ?? "local"))) {
      try {
        if (asset) {
          if (!isResourceId(asset)) throw new ApiError("Invalid file link.", 400);
          if (current()) await openFilePanelResource(asset, signal, true);
        } else if (remembered?.id) await openFilePanelResource(remembered.id, signal, true);
        else if (remembered) await openFilePanel(remembered.path, undefined, true);
      } catch (cause) {
        const error = errorContext(cause);
        if (!current() || aborted(error)) return;
        if (![400, 403, 404, 410].includes(error.status)) throw cause;
        const url = new URL(appState.committedUrl);
        url.searchParams.delete("asset");
        commitUrl(url, "replace");
        storeLayoutPreference(activeWorkspaceKey(), "null");
        documentNotice(`Cannot open file: ${error.message}`, "warning");
      }
    } else if (documentSession.current) {
      if (authenticationSession.mode === "users" && !documentSession.current.id.startsWith("local-new:")) {
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
        if (!documentParticipation) {
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
        refreshControls();
      }
      scheduleAutoSave();
      schedulePreview(0);
    } else {
      const route = readNoteRoute(window.location.href);
      if (route.id)
        void navigateTo(route.id, route.hash, { mode: "replace", url: new URL(window.location.href), initialRead });
      else previewStatus("Select a note");
    }
  } catch (errorCause) {
    const error = errorContext(errorCause);
    if (!current() || aborted(error)) return;
    controller.abort();
    connectionFailure(error, true);
    renderTreeStatus();
  } finally {
    prepared?.controller.abort();
    if (current()) {
      appState.connectionController = null;
      refreshControls();
    }
  }
}
