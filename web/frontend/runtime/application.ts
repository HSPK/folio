import { projectModel } from "../state/projects";
import { authenticationSession } from "../state/authentication";
import { errorContext } from "../types/errors";
import { initializeAccountsAccounts } from "./accounts/accounts";
import { handleAuthenticationFailure, initializeAccountsAuthentication } from "./accounts/authentication";
import { collaborationState, initializeCollaborationCollaboration } from "./collaboration/collaboration";
import { initializeCollaborationParticipation } from "./collaboration/participation";
import { initializeCollaborationPresence } from "./collaboration/presence";
import { appState, initializeCoreBootstrap } from "./core/bootstrap";
import { configureApiClient } from "./core/api";
import { initializeCoreCommands } from "./core/commands";
import { initializeCoreEvents } from "./core/events";
import { initializeCoreLayout } from "./core/layout";
import { initializeEditorHost } from "./editor-host";
import { initializeDialogsDialogs } from "./dialogs/dialogs";
import { initializeDocumentsDrafts, persistCurrentDraft } from "./documents/drafts";
import { initializeDocumentsHistory } from "./documents/history";
import { initializeDocumentsImages } from "./documents/images";
import { initializeDocumentsNavigation } from "./documents/navigation";
import { initializeDocumentsPreview } from "./documents/preview";
import { initializeDocumentsRelated } from "./documents/related";
import { initializeDocumentsResources, rememberResources } from "./documents/resources";
import { initializeDocumentsSaving } from "./documents/saving";
import { beginApplicationLifetime, onApplicationDispose } from "./lifecycle";
import { initializeNavigationFiles } from "./navigation/files";
import { initializeNavigationLibrary } from "./navigation/library";
import { initializeNavigationOutline } from "./navigation/outline";
import { initializeNavigationStatus } from "./navigation/status";
import { initializeNavigationTree } from "./navigation/tree";
import { initializePreferencesSettings } from "./preferences/settings";
import { initializeProjectsDialog, renderProjects } from "./projects/dialog";
import { initializeProjectsProjects, openSharing, switchProject, updateProjectControls } from "./projects/projects";
import { initializeProjectGateway } from "./projects/gateway";
import { initializeSearchSearch } from "./search/search";
import { initializeSharingPublic, scopedApiPath } from "./sharing/public";
import { initializeSharingShares } from "./sharing/shares";
import { initializeWorkspaceControls } from "./workspace/controls";
import { initializeWorkspaceWorkspace } from "./workspace/workspace";

/** Configure domain controllers after Solid has mounted their DOM hosts. */
export function startApplication() {
  const lifetime = beginApplicationLifetime();
  let ready = false;
  const stop = () => {
    if (lifetime.signal.aborted) return;
    if (ready) {
      ready = false;
      if (!collaborationState.collaboration) {
        void persistCurrentDraft().catch((error) =>
          console.warn("Local recovery could not finish during disposal.", error),
        );
      }
    }
    lifetime.dispose();
  };
  try {
    initializeCoreBootstrap();
    initializeEditorHost();
    initializeCoreLayout();
    onApplicationDispose(
      configureApiClient({
        signal: lifetime.signal,
        context(path, headers) {
          if (appState.token) headers.Authorization = `Bearer ${appState.token}`;
          return {
            path: scopedApiPath(path, headers),
            authenticationGeneration: authenticationSession.generation,
            resourceProject: projectModel.active?.id ?? "local",
          };
        },
        onAuthenticationFailure: handleAuthenticationFailure,
        onResources: rememberResources,
      }),
    );
    initializeCoreCommands();
    initializeDialogsDialogs();
    initializeNavigationStatus();
    initializeWorkspaceControls();
    initializeDocumentsDrafts();
    initializeWorkspaceWorkspace();
    initializeAccountsAuthentication();
    initializeNavigationOutline();
    initializePreferencesSettings();
    initializeAccountsAccounts();
    initializeDocumentsResources();
    initializeProjectsDialog({ openSharing, switchProject });
    initializeProjectGateway(() => {
      renderProjects();
      updateProjectControls();
    });
    initializeProjectsProjects();
    initializeSharingPublic();
    initializeSharingShares();
    initializeSearchSearch();
    initializeNavigationLibrary();
    initializeNavigationFiles();
    initializeNavigationTree();
    initializeDocumentsRelated();
    initializeCollaborationParticipation();
    initializeCollaborationPresence();
    initializeCollaborationCollaboration();
    initializeDocumentsImages();
    initializeDocumentsHistory();
    initializeDocumentsSaving();
    initializeDocumentsPreview();
    initializeDocumentsNavigation();
    initializeCoreEvents();
    ready = true;
  } catch (cause) {
    try {
      stop();
    } catch (cleanupError) {
      throw new AggregateError([cause, cleanupError], "The application could not start or release its resources.");
    }
    throw errorContext(cause);
  }
  return stop;
}
