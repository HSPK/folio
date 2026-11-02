import { projectModel } from "../../state/projects";
import { projectViewState as projectState } from "./view-state";
import { authenticationSession } from "../../state/authentication";
import { documentSession } from "../../state/document";
import { libraryModel } from "../../state/library";
import { createProjectTransitions } from "../../services/project-transitions";
import { documentSharing, projectSharing, projectSource, type ProjectChange } from "../../models/projects";
import { createIcon } from "@folio/editor-runtime";
import { isResourceId, readNoteRoute } from "@folio/model";
import type { Project, RouteMode } from "../../types/domain";
import { requiredQuery, requireValue } from "../../types/elements";
import { errorContext } from "../../types/errors";
import { closeMenus } from "../accounts/authentication";
import { pollDocumentParticipation } from "../collaboration/participation";
import { appState } from "../core/bootstrap";
import { ApiError, documentNotice, notice, setText } from "../core/dom";
import { connect } from "../core/connection";
import { readLayoutPreference, storeLayoutPreference } from "../core/layout";
import { hasDialogConfirmation } from "../dialogs/dialogs";
import { captureDraft, discardLocalDraft } from "../documents/drafts";
import { imageState } from "../documents/images";
import { cancelDocumentLoad, clearDocument, commitUrl, restoreCommittedUrl } from "../documents/navigation";
import { documentResource, requestResourceLink, resourceState } from "../documents/resources";
import { cancelAutoSave, saveBeforeLeaving, scheduleAutoSave } from "../documents/saving";
import { applicationSignal, listen, onApplicationDispose } from "../lifecycle";
import { renderFiles } from "../navigation/library";
import { treeState } from "../navigation/tree";
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
        documentNotice("This project is no longer accessible.", "error");
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
  listen(appState.element("projects-open"), "click", () => void openProjects());
  listen(appState.element("settings-projects-open"), "click", () => {
    cancelSettings();
    void openProjects();
  });
  listen(appState.element("project-create-form"), "submit", async (event) => {
    if (!(event.target instanceof Element)) return;
    event.preventDefault();
    if (projectState.projectCreating) return;
    const owner = applicationSignal();
    const scope = authenticationSession.scope;
    const current = () => !owner.aborted && authenticationSession.isCurrent(scope);
    projectState.projectCreating = true;
    refreshProjectBusy();
    const controls = [...appState.element("project-create-form").elements].filter(
      (control): control is HTMLInputElement | HTMLSelectElement | HTMLButtonElement =>
        control instanceof HTMLInputElement ||
        control instanceof HTMLSelectElement ||
        control instanceof HTMLButtonElement,
    );
    const body = {
      action: "create",
      name: appState.element("project-name").value,
      kind: appState.element("project-kind").value,
      source: appState.element("project-source").value.trim(),
    } as const;
    controls.forEach((control) => {
      control.disabled = true;
    });
    setText(appState.element("project-create"), "Creating…");
    notice(appState.element("project-error"), "");
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
      notice(appState.element("project-error"), error.message, "error");
      documentNotice(`Could not create project: ${error.message}`, "error");
    } finally {
      if (!owner.aborted) {
        projectState.projectCreating = false;
        controls.forEach((control) => {
          control.disabled = false;
        });
        setText(appState.element("project-create"), "Create project");
        syncProjectSource();
        refreshProjectBusy();
      }
    }
  });
  listen(appState.element("share-page"), "click", () => {
    closeMenus();
    void openSharing(requireValue(projectModel.active), requireValue(documentSession.current).path);
  });
  listen(appState.element("sharing-cancel"), "click", () => {
    if (projectDialogState.projectSessionOrigin === "document") closeProjectManager();
    else void backProjectView({ discard: true });
  });
  listen(appState.element("sharing-form"), "submit", (event) => {
    event.preventDefault();
    void saveSharing();
  });
  listen(appState.element("sharing-copy-link"), "click", async () => {
    if (appState.element("sharing-copy-link").disabled) return;
    notice(appState.element("sharing-error"), "");
    const target = requireValue(projectState.sharingTarget, "Sharing target");
    const url = new URL(window.location.href);
    url.searchParams.set("project", target.project.id);
    if (target.path) url.searchParams.set("document", requireValue(target.document, "Shared document identity"));
    else url.searchParams.delete("document");
    url.hash = "";
    try {
      const link = target.path ? target.project.publicLinks?.[target.path] : undefined;
      if (appState.element("sharing-level").value === "publicRead" && !link)
        throw new Error("Save the permissions to create the public link first.");
      await navigator.clipboard.writeText(link ? publicShareUrl(link.token) : url.href);
      if (projectState.sharingTarget !== target || !projectManagerOpen()) return;
      setText(appState.element("sharing-copy-link"), "Copied");
      setText(appState.element("sharing-feedback"), "Link copied.");
      appState.element("sharing-feedback").hidden = false;
      documentNotice("");
    } catch (errorCause) {
      const error = errorContext(errorCause);
      notice(appState.element("sharing-error"), `Could not copy the sharing link: ${error.message}`, "error");
    }
  });
}
export function projectStorageKey() {
  return `folio.projects.${authenticationSession.user?.username ?? "local"}`;
}

export function projectUrl(
  value: string | null | undefined,
  documentPath: string | undefined = documentSession.current?.path,
) {
  if (!value || !value.startsWith("/")) return value ?? null;
  const url = new URL(value, window.location.href);
  const project = documentSession.current?.project ?? projectModel.active?.id ?? "local";
  const asset = url.pathname === "/assets" && isResourceId(url.searchParams.get("id"));
  const document = url.pathname === "/" && isResourceId(url.searchParams.get("document"));
  if (!asset && !document) {
    const path = decodeURIComponent(url.pathname.slice(1));
    const resource = resourceState.resourceLocations.get(resourceState.resourceLocation(project, path));
    if (!resource) {
      requestResourceLink(path, /\.(md|markdown)$/i.test(path) ? "document" : "asset");
      return null;
    }
    url.search = "";
    if (resource.kind === "document") {
      url.pathname = "/";
      url.searchParams.set("document", resource.id);
    } else if (resource.kind === "asset") {
      url.pathname = "/assets";
      url.searchParams.set("id", resource.id);
    } else return null;
  }
  const context =
    resourceState.resourceLocations.get(resourceState.resourceLocation(project, documentPath ?? ""))?.id ??
    documentSession.current?.id;
  if (publicState.publicView) {
    if (url.pathname === "/assets") {
      url.pathname = "/api/public/assets";
      url.searchParams.set("share", requireValue(publicState.publicToken, "Public link identity"));
      if (context) url.searchParams.set("document", context);
    } else if (url.pathname === "/") {
      if (url.searchParams.get("document") !== documentSession.current?.id) return null;
      url.pathname = "/share";
      url.search = "";
      url.searchParams.set("share", requireValue(publicState.publicToken, "Public link identity"));
    }
    return url.pathname + url.search + url.hash;
  }
  if (projectModel.active && (url.pathname === "/assets" || url.pathname === "/")) {
    url.searchParams.set("project", project);
  }
  if (url.pathname === "/assets" && context) url.searchParams.set("document", context);
  return url.pathname + url.search + url.hash;
}
export function updateProjectControls(): void {
  appState.ui.settingsOpen.hidden = publicState.publicView;
  appState.ui.sidebarToggle.hidden = publicState.publicView;
  appState.element("sidebar-settings-open").hidden = publicState.publicView;
  appState.element("projects-open").hidden = authenticationSession.mode !== "users";
  appState.element("app-name").hidden = authenticationSession.mode === "users";
  setText(appState.element("projects-open"), projectModel.active?.name ?? "Projects");
  appState.element("share-page").hidden = !projectModel.active?.owned || !documentSession.current;
}
export async function ensureProject(isCurrent = () => true) {
  if (authenticationSession.mode !== "users") return true;
  const scope = authenticationSession.scope;
  const current = () => isCurrent() && authenticationSession.isCurrent(scope);
  await loadProjects();
  if (!current()) return false;
  const url = new URL(appState.committedUrl);
  let requested = url.searchParams.get("project");
  const documentRoute = readNoteRoute(url);
  if (!requested && documentRoute.id) {
    const resource = await documentResource(documentRoute.id, scope.signal);
    if (!current()) return false;
    requested = resource.project;
  }
  const chosen = requested ?? projectModel.active?.id ?? readLayoutPreference(projectStorageKey());
  const project =
    projectModel.items.find((project) => project.id === chosen) ?? (requested ? null : (projectModel.items[0] ?? null));
  projectModel.select(project?.id ?? null);
  updateProjectControls();
  if (!projectModel.active) {
    if (requested)
      throw new ApiError("This project is private or no longer shared with you. Open Projects to choose another.", 403);
    appState.connectionState = "ready";
    appState.currentRoot = null;
    renderFiles();
    documentNotice("No project selected.");
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
    documentNotice(`Could not finish switching projects: ${error.message}`, "error");
    if (mode === "pop") restoreCommittedUrl();
    return false;
  }
}
export function projectOperationPending() {
  return (
    documentSession.saving ||
    appState.creating ||
    appState.movingEntry ||
    projectState.projectCreating ||
    imageState.imageUploading
  );
}
export async function allowProjectSwitch(action: string, signal?: AbortSignal) {
  if (signal?.aborted) return false;
  if (appState.creating || appState.movingEntry || projectState.projectCreating || imageState.imageUploading) {
    documentNotice("Wait for the current operation before switching projects.");
    return false;
  }
  if (!(await saveBeforeLeaving(action, signal)) || signal?.aborted) return false;
  if (projectOperationPending()) {
    documentNotice("Wait for the current operation before switching projects.");
    return false;
  }
  return true;
}
export async function activateProject(
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
  const next = new URL(url ?? appState.committedUrl);
  next.searchParams.set("project", id);
  if (!url) {
    next.searchParams.delete("document");
    next.hash = "";
  }
  commitUrl(next, mode);
  const operation = Symbol("project-activation");
  activation = operation;
  const current = () => !owner.aborted && authenticationSession.isCurrent(scope) && activation === operation;
  treeState.documentPrefetch.clear();
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
  appState.ui.filter.value = "";
  storeLayoutPreference(projectStorageKey(), id);
  closeProjectManager();
  renderFiles();
  updateProjectControls();
  try {
    await discardLocalDraft(discardedDraft);
  } finally {
    if (current()) await connect({ restoreWorkspace: !directoryChanged });
  }
  return current();
}
export async function openProjects(): Promise<void> {
  const owner = applicationSignal();
  const scope = authenticationSession.scope;
  closeMenus();
  requiredQuery(appState.element("project-kind"), '[value="folder"]', HTMLElement).hidden =
    authenticationSession.user?.role !== "admin";
  if (authenticationSession.user?.role !== "admin" && appState.element("project-kind").value === "folder")
    appState.element("project-kind").value = "new";
  appState.element("projects-filter").value = "";
  showProjectBrowse();
  openProjectManager();
  appState.element("projects-filter").focus();
  try {
    await loadProjects();
  } catch (errorCause) {
    if (owner.aborted || !authenticationSession.isCurrent(scope)) return;
    const error = errorContext(errorCause);
    notice(appState.element("project-error"), error.message, "error");
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
    documentNotice("This project is no longer accessible.", "error");
    return;
  }
  project = current;
  resourceId ??= path
    ? (project.documentIds?.[path] ??
      resourceState.resourceLocations.get(resourceState.resourceLocation(project.id, path))?.id ??
      null)
    : null;
  if (path && !isResourceId(resourceId)) {
    documentNotice("This document identity is unavailable. Refresh the project before changing permissions.", "error");
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
  setText(appState.element("sharing-title"), path ? "Document permissions" : "Project settings");
  setText(appState.element("sharing-description"), path ?? project.name);
  const options = [
    ...(path ? [["inherit", "Inherit Project permission"]] : []),
    ["private", "Private (owner only)"],
    ["read", "Signed-in users can read"],
    ["edit", "Signed-in users can edit"],
    ...(path ? [["publicRead", "Public link (no login required)"]] : []),
  ];
  appState.element("sharing-level").replaceChildren(...options.map(([value, label]) => new Option(label, value)));
  const link = path ? project.publicLinks?.[path] : null;
  appState.element("sharing-level").value = path
    ? link
      ? "publicRead"
      : (project.pages[path] ?? "inherit")
    : project.shared;
  appState.element("sharing-public-edit").checked = link?.access === "edit";
  const expiration = link?.expiresAt ? new Date(link.expiresAt) : null;
  appState.element("sharing-expires").value = expiration
    ? new Date(expiration.getTime() - expiration.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
    : "";
  appState.element("sharing-password").value = "";
  appState.element("sharing-password").disabled = false;
  appState.element("sharing-clear-password").checked = false;
  appState.element("sharing-clear-password-field").hidden = !link?.passwordRequired;
  renderPublicShareFields();
  const documents = [...new Set([...Object.keys(project.pages), ...Object.keys(project.publicLinks ?? {})])].sort();
  appState.element("sharing-documents").replaceChildren(
    ...(path ? [] : documents).map((documentPath) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "project-open";
      button.append(
        createIcon(project.publicLinks?.[documentPath] ? "globe" : "file"),
        document.createTextNode(documentPath),
      );
      button.addEventListener(
        "click",
        () => void openSharing(project, documentPath, project.documentIds?.[documentPath]),
      );
      return button;
    }),
  );
  appState.element("sharing-documents-section").hidden = Boolean(path) || !documents.length;
  appState.element("sharing-project-fields").hidden = Boolean(path);
  appState.element("sharing-name").value = project.name;
  appState.element("sharing-root").value = project.root ?? "";
  appState.element("sharing-root").readOnly = authenticationSession.user?.role !== "admin";
  appState.element("sharing-image-directory").value = project.imageDirectory;
  appState.element("sharing-name").required = !path;
  appState.element("sharing-root").required = !path;
  appState.element("sharing-image-directory").required = !path;
  notice(appState.element("sharing-error"), "");
  setProjectView("sharing");
  projectDialogState.projectFormSnapshot = projectFormState();
  refreshSharingCopy();
  openProjectManager();
  appState.element(path ? "sharing-level" : "sharing-name").focus();
}
export async function saveSharing(resetLink = false): Promise<void> {
  if (projectDialogState.sharingSaving || hasDialogConfirmation(projectDialogState.projectDialog)) return;
  const owner = applicationSignal();
  const scope = authenticationSession.scope;
  const current = () => !owner.aborted && authenticationSession.isCurrent(scope);
  const target = requireValue(projectState.sharingTarget, "Sharing target");
  const { project, path, document } = target;
  const selection = projectModel.selection;
  const root = appState.element("sharing-root").value.trim();
  const fields = {
    name: appState.element("sharing-name").value,
    imageDirectory: appState.element("sharing-image-directory").value.trim(),
    permission: appState.element("sharing-level").value,
    publicEdit: appState.element("sharing-public-edit").checked,
    expiration: appState.element("sharing-expires").value,
    password: appState.element("sharing-password").value || null,
    clearPassword: appState.element("sharing-clear-password").checked,
  };
  const changingRoot = !path && !appState.element("sharing-root").readOnly && root !== project.root;
  const changingActiveRoot = changingRoot && projectModel.active?.id === project.id;
  projectDialogState.sharingSaving = true;
  refreshProjectBusy();
  appState.element("sharing-save").disabled = true;
  setText(appState.element("sharing-save"), "Saving…");
  appState.element("sharing-reset-link").disabled = true;
  notice(appState.element("sharing-error"), "");
  try {
    let body: ProjectChange;
    if (path) {
      const permission = documentSharing(
        fields.permission === "publicRead" && fields.publicEdit ? "publicEdit" : fields.permission,
      );
      const expiresAt = fields.expiration ? new Date(fields.expiration).getTime() : null;
      if (expiresAt !== null && !Number.isFinite(expiresAt)) throw new Error("Choose a valid expiration time.");
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
    appState.element("sharing-password").value = "";
    appState.element("sharing-clear-password").checked = false;
    appState.element("sharing-clear-password-field").hidden = !path || !next.publicLinks?.[path]?.passwordRequired;
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
    notice(appState.element("sharing-error"), error.message, "error");
  } finally {
    if (!owner.aborted) {
      projectDialogState.sharingSaving = false;
      appState.element("sharing-save").disabled = false;
      setText(appState.element("sharing-save"), "Save");
      appState.element("sharing-reset-link").disabled = false;
      refreshProjectBusy();
      refreshSharingCopy();
      if (changingActiveRoot && selection === projectModel.selection) scheduleAutoSave();
      if (projectManagerOpen() && projectDialogState.projectView === "browse")
        appState.element("projects-filter").focus();
    }
  }
}
