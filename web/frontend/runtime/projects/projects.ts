import { projectModel } from "../../state/projects";
import { projectViewState as projectState } from "./view-state";
import { authenticationSession } from "../../state/authentication";
import { documentSession } from "../../state/document";
import { libraryModel, libraryView } from "../../state/library";
import { createProjectTransitions } from "../../services/project-transitions";
import {
  documentSharing,
  projectSharing,
  projectSource,
  type ProjectChange,
  compactPageUrl,
  expandedPageUrl,
  isResourceId,
  readNoteRoute,
} from "@folio/model";
import { createButton } from "@folio/editor-runtime";
import type { Project, RouteMode } from "../../types/domain";
import { element, requiredQuery, requireValue } from "../../types/elements";
import { errorContext } from "../../types/errors";
import { closeMenus } from "../accounts/authentication";
import { pollDocumentParticipation } from "../collaboration/participation";
import { appState } from "../core/bootstrap";
import { ApiError, documentNotice, notice, setText } from "../core/dom";
import { connect } from "../core/connection";
import { api } from "../core/api";
import { decodedResource } from "../../api/contracts";
import { readLayoutPreference, storeLayoutPreference } from "../core/layout";
import { confirmAction, hasDialogConfirmation } from "../dialogs/dialogs";
import { captureDraft, discardLocalDraft } from "../documents/drafts";
import { imageUploading } from "../documents/images";
import { cancelDocumentLoad, clearDocument, commitUrl, restoreCommittedUrl } from "../documents/navigation";
import { documentResource, resourceState } from "../documents/resources";
import { cancelAutoSave, saveBeforeLeaving, scheduleAutoSave } from "../documents/saving";
import { applicationLifetime, applicationSignal, listen, onApplicationDispose } from "../lifecycle";
import { buttonFeedback } from "../../../shared/feedback";
import { renderFiles } from "../navigation/library";
import { clearTreePrefetch } from "../navigation/tree";
import { cancelSettings } from "../preferences/settings";
import { changeProject, loadProjectCatalog as loadProjects } from "./gateway";
import { publicShareUrl, publicState, refreshSharingCopy, renderPublicShareFields } from "../sharing/public";
import {
  allowProjectNavigation,
  backProjectView,
  closeProjectManager,
  openProjectManager,
  projectDialogState,
  projectFormState,
  projectManagerOpen,
  refreshProjectBusy,
  renderProjects,
  setProjectView,
  focusProjectList,
  showProjectBrowse,
  syncProjectSource,
} from "./dialog";

let projectTransitions: ReturnType<typeof createProjectTransitions> | null = null;
let activation: symbol | null = null;
export function initializeProjectsProjects(): void {
  projectState.projectCreating = false;
  projectState.sharingTarget = null;
  activation = null;
  const transitions = createProjectTransitions({
    signal: applicationSignal(),
    scope: () => authenticationSession.scope,
    async prepare(_target, signal) {
      if (projectManagerOpen() && !(await allowProjectNavigation(signal))) return false;
      if (signal.aborted) return false;
      return allowProjectSwitch("switch projects", signal);
    },
    activate(target, signal) {
      const project = projectModel.items.find((project) => project.id === target.id);
      if (!project) {
        documentNotice("Project unavailable", "error");
        return Promise.resolve(false);
      }
      return activateProject(project, { url: target.url, mode: target.mode, signal });
    },
  });
  projectTransitions = transitions;
  onApplicationDispose(() => {
    transitions.cancel();
    if (projectTransitions === transitions) {
      projectTransitions = null;
      activation = null;
    }
  });
  listen(element("projects-open"), "click", () => void openProjects());
  listen(element("settings-projects-open"), "click", async () => {
    if (await cancelSettings()) await openProjects();
  });
  listen(element("project-create-form"), "submit", async (event) => {
    if (!(event.target instanceof Element)) return;
    event.preventDefault();
    if (projectState.projectCreating) return;
    const owner = applicationSignal();
    const scope = authenticationSession.scope;
    const current = () => !owner.aborted && authenticationSession.isCurrent(scope);
    projectState.projectCreating = true;
    refreshProjectBusy();
    const controls = [...element("project-create-form").elements].filter(
      (control): control is HTMLInputElement | HTMLSelectElement | HTMLButtonElement =>
        control instanceof HTMLInputElement ||
        control instanceof HTMLSelectElement ||
        control instanceof HTMLButtonElement,
    );
    const body = {
      action: "create",
      name: element("project-name").value,
      kind: element("project-kind").value,
      source: element("project-source").value.trim(),
    } as const;
    controls.forEach((control) => {
      control.disabled = true;
    });
    setText(element("project-create"), "Creating…");
    notice(element("project-error"), "");
    documentNotice("Creating project…");
    try {
      const project = await changeProject({ ...body, kind: projectSource(body.kind) });
      if (!current()) return;
      projectState.projectCreating = false;
      projectDialogState.projectFormSnapshot = null;
      showProjectBrowse();
      renderProjects();
      await switchProject(project.id);
      if (current()) documentNotice("");
    } catch (errorCause) {
      if (!current()) return;
      const error = errorContext(errorCause);
      notice(element("project-error"), error.message, "error");
      documentNotice(`Create failed: ${error.message}`, "error");
    } finally {
      if (!owner.aborted) {
        projectState.projectCreating = false;
        controls.forEach((control) => {
          control.disabled = false;
        });
        setText(element("project-create"), "Create project");
        syncProjectSource();
        refreshProjectBusy();
      }
    }
  });
  listen(element("share-page"), "click", () => {
    closeMenus();
    void openSharing(requireValue(projectModel.active), requireValue(documentSession.current).path);
  });
  listen(element("sharing-cancel"), "click", () => {
    if (projectDialogState.projectSessionOrigin === "document") closeProjectManager();
    else void backProjectView({ discard: true });
  });
  listen(element("sharing-form"), "submit", (event) => {
    event.preventDefault();
    void saveSharing();
  });
  listen(element("sharing-copy-link"), "click", async () => {
    if (element("sharing-copy-link").disabled) return;
    notice(element("sharing-error"), "");
    const target = requireValue(projectState.sharingTarget, "Sharing target");
    const url = new URL("/", window.location.href);
    url.searchParams.set("project", target.project.id);
    if (target.path)
      url.searchParams.set(
        /\.(md|markdown)$/i.test(target.path) ? "document" : "asset",
        requireValue(target.document, "Shared file identity"),
      );
    else url.searchParams.delete("document");
    url.hash = "";
    try {
      const link = target.path ? target.project.publicLinks?.[target.path] : undefined;
      if (element("sharing-level").value === "publicRead" && !link) throw new Error("Save permissions first");
      if (
        !link &&
        target.path &&
        /\.(md|markdown)$/i.test(target.path) &&
        target.document &&
        compactPageUrl(url).pathname.length !== "/n/".length + 8
      ) {
        await api(`/api/resource?id=${target.document}`, {
          decode: decodedResource,
          signal: authenticationSession.scope.signal,
        });
        if (projectState.sharingTarget !== target) return;
      }
      await copyPlainText(link ? publicShareUrl(link.token) : compactPageUrl(url).href);
      if (projectState.sharingTarget !== target || !projectManagerOpen()) return;
      buttonFeedback(element("sharing-copy-link"), "Copied", applicationLifetime());
      setText(element("sharing-feedback"), "Link copied");
      element("sharing-feedback").hidden = false;
      documentNotice("");
    } catch (errorCause) {
      const error = errorContext(errorCause);
      notice(element("sharing-error"), `Copy failed: ${error.message}`, "error");
    }
  });
}
export function projectStorageKey() {
  return `folio.projects.${authenticationSession.user?.username ?? "local"}`;
}

export function updateProjectControls(): void {
  element("settings-open").hidden = publicState.publicView;
  element("sidebar-toggle").hidden = publicState.publicView;
  element("sidebar-settings-open").hidden = publicState.publicView;
  element("projects-open").hidden = authenticationSession.mode !== "users";
  element("app-name").hidden = authenticationSession.mode === "users";
  setText(element("projects-open"), projectModel.active?.name ?? "Projects");
  element("share-page").hidden = !projectModel.active?.owned || !documentSession.resourceId;
}
export async function ensureProject(isCurrent = () => true) {
  if (authenticationSession.mode !== "users") return true;
  const scope = authenticationSession.scope;
  const current = () => isCurrent() && authenticationSession.isCurrent(scope);
  if (!current()) return false;
  const url = new URL(appState.committedUrl);
  let requested = url.searchParams.get("project");
  const documentRoute = readNoteRoute(url);
  const resourceId = documentRoute.id ?? url.searchParams.get("asset");
  if (!requested && isResourceId(resourceId)) {
    try {
      const resource = await documentResource(resourceId, scope.signal);
      if (!current()) return false;
      requested = resource.project;
    } catch (error) {
      if (documentRoute.id || !(error instanceof ApiError) || ![403, 404, 410].includes(error.status)) throw error;
    }
  }
  const chosen = requested ?? projectModel.active?.id ?? readLayoutPreference(projectStorageKey());
  const project =
    projectModel.items.find((project) => project.id === chosen) ?? (requested ? null : (projectModel.items[0] ?? null));
  projectModel.select(project?.id ?? null);
  updateProjectControls();
  if (!projectModel.active) {
    if (requested) throw new ApiError("Project unavailable", 403);
    appState.connectionState = "ready";
    appState.currentRoot = null;
    renderFiles();
    documentNotice("No project selected");
    return false;
  }
  url.searchParams.set("project", projectModel.active.id);
  commitUrl(url, "replace");
  storeLayoutPreference(projectStorageKey(), projectModel.active.id);
  return true;
}
export async function switchProject(
  id: string | null,
  {
    url = null,
    mode = "push",
  }: {
    url?: URL | null;
    mode?: RouteMode;
  } = {},
) {
  if (id === projectModel.active?.id && !url) {
    projectTransitions?.cancel();
    closeProjectManager();
    return true;
  }
  try {
    const result = await requireValue(projectTransitions, "Project transitions").request({ id, url, mode });
    if (!result && mode === "pop") restoreCommittedUrl();
    return result;
  } catch (cause) {
    const error = errorContext(cause);
    documentNotice(`Switch failed: ${error.message}`, "error");
    if (mode === "pop") restoreCommittedUrl();
    return false;
  }
}
function projectOperationPending() {
  return (
    documentSession.saving ||
    appState.creating ||
    appState.movingEntry ||
    projectState.projectCreating ||
    imageUploading
  );
}
async function allowProjectSwitch(action: string, signal?: AbortSignal) {
  if (signal?.aborted) return false;
  if (appState.creating || appState.movingEntry || projectState.projectCreating || imageUploading) {
    documentNotice("Operation in progress");
    return false;
  }
  if (!(await saveBeforeLeaving(action, signal)) || signal?.aborted) return false;
  if (libraryView.pending.length && !(await confirmAction("Leave with unsynced files?", { label: "Leave", signal })))
    return false;
  if (projectOperationPending()) {
    documentNotice("Operation in progress");
    return false;
  }
  return true;
}
async function activateProject(
  project: Project,
  {
    url = null,
    mode = "push",
    directoryChanged = false,
    signal,
  }: {
    url?: URL | null;
    mode?: RouteMode;
    directoryChanged?: boolean;
    signal?: AbortSignal;
  } = {},
) {
  const owner = applicationSignal();
  const scope = authenticationSession.scope;
  if (owner.aborted || scope.signal.aborted || signal?.aborted) return false;
  const discardedDraft = directoryChanged ? captureDraft() : null;
  const id = project.id;
  const next = expandedPageUrl(url ?? appState.committedUrl);
  next.searchParams.set("project", id);
  if (!url) {
    next.searchParams.delete("document");
    next.searchParams.delete("asset");
    next.hash = "";
  }
  commitUrl(next, mode);
  const operation = Symbol("project-activation");
  activation = operation;
  const current = () => !owner.aborted && authenticationSession.isCurrent(scope) && activation === operation;
  clearTreePrefetch();
  cancelDocumentLoad(false);
  appState.treeController?.abort();
  appState.treeGate.invalidate();
  appState.connectionController?.abort();
  appState.connectionGate.invalidate();
  appState.connectionState = "connecting";
  clearDocument(next, "replace");
  projectModel.select(project.id, true);
  appState.currentRoot = null;
  libraryModel.reset();
  element("file-filter").value = "";
  storeLayoutPreference(projectStorageKey(), id);
  closeProjectManager();
  renderFiles();
  updateProjectControls();
  try {
    await discardLocalDraft(discardedDraft);
  } finally {
    if (current()) await connect({ restoreWorkspace: !directoryChanged, selectedProject: projectModel.selection });
  }
  return current();
}
async function openProjects(): Promise<void> {
  const owner = applicationSignal();
  const scope = authenticationSession.scope;
  closeMenus();
  requiredQuery(element("project-kind"), '[value="folder"]', HTMLElement).hidden =
    authenticationSession.user?.role !== "admin";
  if (authenticationSession.user?.role !== "admin" && element("project-kind").value === "folder")
    element("project-kind").value = "new";
  element("projects-filter").value = "";
  showProjectBrowse();
  openProjectManager();
  focusProjectList();
  try {
    await loadProjects();
    if (
      projectManagerOpen() &&
      projectDialogState.projectView === "browse" &&
      (document.activeElement === document.body || document.activeElement === element("projects-close"))
    )
      focusProjectList();
  } catch (errorCause) {
    if (owner.aborted || !authenticationSession.isCurrent(scope)) return;
    const error = errorContext(errorCause);
    notice(element("project-error"), error.message, "error");
  }
}
export async function openSharing(
  project: Project,
  path: string | null = null,
  resourceId: string | null = null,
): Promise<void> {
  const owner = applicationSignal();
  const scope = authenticationSession.scope;
  if (!(await allowProjectNavigation())) return;
  if (owner.aborted || !authenticationSession.isCurrent(scope)) return;
  const current = projectModel.get(project.id);
  if (!current) {
    documentNotice("Project unavailable", "error");
    return;
  }
  project = current;
  resourceId ??= path
    ? (project.documentIds?.[path] ??
      resourceState.resourceLocations.get(resourceState.resourceLocation(project.id, path))?.id ??
      null)
    : null;
  if (path && !isResourceId(resourceId)) {
    documentNotice("Document unavailable", "error");
    return;
  }
  const parent =
    projectManagerOpen() && projectDialogState.projectView === "sharing" && !projectState.sharingTarget?.path && path
      ? requireValue(projectState.sharingTarget).project
      : null;
  if (!projectManagerOpen()) projectDialogState.projectSessionOrigin = path ? "document" : "browse";
  projectDialogState.projectParent = parent;
  projectState.sharingTarget = { project, path, document: resourceId };
  projectDialogState.projectDialog.dataset.scope = path ? "document" : "project";
  const file = Boolean(path && !/\.(md|markdown)$/i.test(path));
  const readOnly = Boolean(path && /\.(pdf|xlsx)$/i.test(path));
  setText(element("sharing-title"), path ? (file ? "File permissions" : "Document permissions") : "Project settings");
  setText(element("sharing-description"), path ?? project.name);
  const options = [
    ...(path ? [["inherit", "Inherit Project permission"]] : []),
    ["private", "Private (owner only)"],
    ["read", "Signed-in users can read"],
    ...(!readOnly ? [["edit", "Signed-in users can edit"]] : []),
    ...(path ? [["publicRead", "Public link (no login required)"]] : []),
  ];
  element("sharing-level").replaceChildren(...options.map(([value, label]) => new Option(label, value)));
  const link = path ? project.publicLinks?.[path] : null;
  element("sharing-level").value = path ? (link ? "publicRead" : (project.pages[path] ?? "inherit")) : project.shared;
  element("sharing-public-edit").checked = !file && link?.access === "edit";
  element("sharing-public-edit").disabled = file;
  element("sharing-public-edit").closest("label")!.hidden = file;
  const expiration = link?.expiresAt ? new Date(link.expiresAt) : null;
  element("sharing-expires").value = expiration
    ? new Date(expiration.getTime() - expiration.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
    : "";
  element("sharing-password").value = "";
  element("sharing-password").disabled = false;
  element("sharing-clear-password").checked = false;
  element("sharing-clear-password-field").hidden = !link?.passwordRequired;
  renderPublicShareFields();
  const documents = [...new Set([...Object.keys(project.pages), ...Object.keys(project.publicLinks ?? {})])].sort();
  element("sharing-documents").replaceChildren(
    ...(path ? [] : documents).map((documentPath) => {
      const button = createButton({
        label: documentPath,
        icon: project.publicLinks?.[documentPath] ? "globe" : "file",
        text: documentPath,
        onClick: () => void openSharing(project, documentPath, project.documentIds?.[documentPath]),
      });
      button.className = "project-open";
      return button;
    }),
  );
  element("sharing-documents-section").hidden = Boolean(path) || !documents.length;
  element("sharing-project-fields").hidden = Boolean(path);
  element("sharing-name").value = project.name;
  element("sharing-root").value = project.root ?? "";
  element("sharing-root").readOnly = authenticationSession.user?.role !== "admin";
  element("sharing-image-directory").value = project.imageDirectory;
  element("sharing-name").required = !path;
  element("sharing-root").required = !path;
  element("sharing-image-directory").required = !path;
  notice(element("sharing-error"), "");
  setProjectView("sharing");
  projectDialogState.projectFormSnapshot = projectFormState();
  refreshSharingCopy();
  openProjectManager();
  element(path ? "sharing-level" : "sharing-name").focus();
}
export async function saveSharing(resetLink = false): Promise<void> {
  if (projectDialogState.sharingSaving || hasDialogConfirmation(projectDialogState.projectDialog)) return;
  const owner = applicationSignal();
  const scope = authenticationSession.scope;
  const current = () => !owner.aborted && authenticationSession.isCurrent(scope);
  const target = requireValue(projectState.sharingTarget, "Sharing target");
  const { project, path, document } = target;
  const selection = projectModel.selection;
  const root = element("sharing-root").value.trim();
  const fields = {
    name: element("sharing-name").value,
    imageDirectory: element("sharing-image-directory").value.trim(),
    permission: element("sharing-level").value,
    publicEdit: element("sharing-public-edit").checked,
    expiration: element("sharing-expires").value,
    password: element("sharing-password").value || null,
    clearPassword: element("sharing-clear-password").checked,
  };
  const changingRoot = !path && !element("sharing-root").readOnly && root !== project.root;
  const changingActiveRoot = changingRoot && projectModel.active?.id === project.id;
  projectDialogState.sharingSaving = true;
  refreshProjectBusy();
  element("sharing-save").disabled = true;
  setText(element("sharing-save"), "Saving…");
  element("sharing-reset-link").disabled = true;
  notice(element("sharing-error"), "");
  try {
    let body: ProjectChange;
    if (path) {
      const permission = documentSharing(
        fields.permission === "publicRead" && fields.publicEdit ? "publicEdit" : fields.permission,
      );
      const expiresAt = fields.expiration ? new Date(fields.expiration).getTime() : null;
      if (expiresAt !== null && !Number.isFinite(expiresAt)) throw new Error("Invalid expiration time");
      body = {
        action: "document",
        id: project.id,
        document: requireValue(document, "Shared document identity"),
        permission,
        resetLink,
        ...(permission.startsWith("public")
          ? {
              publicOptions: {
                expiresAt,
                password: fields.password,
                clearPassword: fields.clearPassword,
              },
            }
          : {}),
      };
    } else {
      const shared = projectSharing(fields.permission);
      body = {
        action: "share",
        id: project.id,
        ...(fields.name !== project.name ? { name: fields.name } : {}),
        ...(fields.imageDirectory !== project.imageDirectory ? { imageDirectory: fields.imageDirectory } : {}),
        ...(shared !== project.shared ? { shared } : {}),
        ...(changingRoot ? { root } : {}),
      };
    }
    if (changingActiveRoot) {
      if (!(await allowProjectSwitch("change the project folder", scope.signal)) || !current()) return;
      cancelAutoSave();
    }
    const next = await changeProject(body);
    if (!current()) return;
    const changedActiveRoot =
      changingActiveRoot &&
      next.root !== project.root &&
      selection === projectModel.selection &&
      projectModel.active?.id === next.id;
    if (!changedActiveRoot) void pollDocumentParticipation();
    if (projectState.sharingTarget !== target) return;
    target.project = next;
    element("sharing-password").value = "";
    element("sharing-clear-password").checked = false;
    element("sharing-clear-password-field").hidden = !path || !next.publicLinks?.[path]?.passwordRequired;
    projectDialogState.projectFormSnapshot = null;
    if (changedActiveRoot) {
      await activateProject(next, { directoryChanged: true });
    } else if (body.action === "document" && body.permission.startsWith("public")) {
      renderPublicShareFields();
      projectDialogState.projectFormSnapshot = projectFormState();
    } else if (projectDialogState.projectSessionOrigin === "document") closeProjectManager();
    else if (path && projectDialogState.projectParent) {
      projectDialogState.sharingSaving = false;
      await backProjectView({ discard: true });
    } else showProjectBrowse();
    if (current()) documentNotice("");
  } catch (errorCause) {
    if (!current()) return;
    const error = errorContext(errorCause);
    notice(element("sharing-error"), error.message, "error");
  } finally {
    if (!owner.aborted) {
      projectDialogState.sharingSaving = false;
      element("sharing-save").disabled = false;
      setText(element("sharing-save"), "Save");
      element("sharing-reset-link").disabled = false;
      refreshProjectBusy();
      refreshSharingCopy();
      if (changingActiveRoot && selection === projectModel.selection) scheduleAutoSave();
      if (projectManagerOpen() && projectDialogState.projectView === "browse") focusProjectList();
    }
  }
}
import { copyPlainText } from "../../../shared/clipboard";
