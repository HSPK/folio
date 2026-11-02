import { loadProjectCatalog as loadProjects } from "../projects/gateway";
import { projectModel } from "../../state/projects";
import { authenticationSession } from "../../state/authentication";
import { documentSession } from "../../state/document";
import { decodedWorkspace } from "../../api/contracts";
import { restoredWorkspaceNote, sameWorkspaceNote, type WorkspaceAction } from "../../models/workspace-lists";
import { createWorkspaceService } from "../../services/workspace";
import { workspaceModel } from "../../state/workspace";
import type { WorkspaceNote } from "../../types/domain";
import { requireValue } from "../../types/elements";
import { errorContext } from "../../types/errors";
import { isRecord } from "../../types/guards";
import { isAbortError } from "../../api/error";
import { closeMenus, handleAuthenticationFailure } from "../accounts/authentication";
import { api } from "../core/api";
import { appState } from "../core/bootstrap";
import { documentNotice, notice, setText } from "../core/dom";
import { readLayoutPreference, storeLayoutPreference } from "../core/layout";
import { showDialog } from "../dialogs/dialogs";
import { persistCurrentDraft } from "../documents/drafts";
import { commitUrl, navigateTo } from "../documents/navigation";
import { applicationSignal, listen, onApplicationDispose } from "../lifecycle";
import { switchProject } from "../projects/projects";

let workspaceService: ReturnType<typeof createWorkspaceService> | null = null;
let workspaceControlSignature: string | null = null;
export function initializeWorkspaceWorkspace(): void {
  const dialog = appState.element("workspace-dialog");
  workspaceModel.reset();
  workspaceControlSignature = null;
  const service = createWorkspaceService({
    signal: applicationSignal(),
    scope: () => authenticationSession.scope,
    model: workspaceModel,
    read: (signal) => api("/api/workspace", { decode: decodedWorkspace, signal, timeoutMs: 15000 }),
    write: (action, signal) =>
      api("/api/workspace", { decode: decodedWorkspace, signal, timeoutMs: 15000, method: "POST", body: action }),
    changed() {
      refreshWorkspaceFavorite();
      if (dialog.open) renderWorkspaceList();
    },
  });
  workspaceService = service;
  const unsubscribe = authenticationSession.subscribe(service.syncOwner);
  service.syncOwner();
  onApplicationDispose(() => {
    unsubscribe();
    if (workspaceService === service) {
      workspaceService = null;
      workspaceModel.reset();
      workspaceControlSignature = null;
    }
  });
  listen(appState.element("workspace-open"), "click", () => void openWorkspace());
  listen(appState.element("sidebar-workspace-open"), "click", () => void openWorkspace());
  listen(appState.element("workspace-close"), "click", () => dialog.close());
  listen(appState.element("workspace-kind"), "change", renderWorkspaceList);
  listen(appState.element("workspace-filter"), "input", renderWorkspaceList);
  listen(appState.element("workspace-favorite"), "click", async () => {
    closeMenus();
    if (!projectModel.active || !documentSession.current) return;
    const project = projectModel.active.id;
    const id = documentSession.current.id;
    const value = !workspaceModel.lists.favorites.some((note) => sameWorkspaceNote(note, project, id));
    try {
      await changeWorkspace({ action: "favorite", project, id, value });
    } catch (errorCause) {
      if (isAbortError(errorCause)) return;
      const error = errorContext(errorCause);
      documentNotice(`Could not update your workspace: ${error.message}`, "error");
    }
  });
  listen(window, "focus", () => {
    if (authenticationSession.mode === "users") void loadUserWorkspace();
  });
}
export function activeWorkspaceKey() {
  return `folio.workspace.active.${authenticationSession.user?.scope ?? ""}.${authenticationSession.user?.id ?? authenticationSession.user?.username ?? ""}`;
}

export async function loadUserWorkspace(): Promise<void> {
  if (
    authenticationSession.mode !== "users" ||
    !appState.ui.authScreen.hidden ||
    authenticationSession.scope.signal.aborted
  )
    return;
  try {
    await requireValue(workspaceService, "Account workspace").load();
  } catch (errorCause) {
    if (isAbortError(errorCause)) return;
    const error = errorContext(errorCause);

    if (!handleAuthenticationFailure(error))
      documentNotice(`Could not load your workspace: ${error.message}`, "warning");
  }
}

export async function changeWorkspace(action: WorkspaceAction) {
  return requireValue(workspaceService, "Account workspace").change(action);
}

export function noteVisited(): void {
  if (authenticationSession.mode !== "users" || !projectModel.active || !documentSession.current) return;
  const note = { project: projectModel.active.id, id: documentSession.current.id };
  storeLayoutPreference(activeWorkspaceKey(), JSON.stringify(note));
  void changeWorkspace({ action: "visit", ...note }).catch((error) => {
    if (!isAbortError(error)) documentNotice(`Could not remember this note: ${error.message}`, "warning");
  });
}

export function restoreActiveWorkspaceNote(): void {
  if (!workspaceModel.loaded || documentSession.current || authenticationSession.mode !== "users") return;
  const url = new URL(window.location.href);
  if (url.searchParams.has("document")) return;
  const requested = url.searchParams.get("project");
  let saved: { id: string; project: string } | null = null;
  try {
    const value: unknown = JSON.parse(readLayoutPreference(activeWorkspaceKey()) ?? "null");
    if (isRecord(value) && typeof value.id === "string" && typeof value.project === "string")
      saved = { id: value.id, project: value.project };
    else if (value !== null) console.warn("The stored active note has an invalid identity.");
  } catch (errorCause) {
    const error = errorContext(errorCause);
    console.warn("The stored active note is invalid.", error);
  }
  const note = restoredWorkspaceNote(workspaceModel.lists, requested, saved);
  if (!note) return;
  url.searchParams.set("project", note.project);
  url.searchParams.set("document", note.id);
  commitUrl(url, "replace");
}

export function refreshWorkspaceFavorite(): void {
  if (authenticationSession.mode !== "users") {
    workspaceControlSignature = null;
    return;
  }
  const signature = JSON.stringify([
    workspaceModel.principal,
    workspaceModel.revision,
    projectModel.active?.id,
    documentSession.current?.id,
  ]);
  if (signature === workspaceControlSignature) return;
  workspaceControlSignature = signature;
  const isActive = (note: WorkspaceNote) =>
    projectModel.active &&
    documentSession.current &&
    sameWorkspaceNote(note, projectModel.active.id, documentSession.current.id);
  setText(
    appState.element("workspace-favorite"),
    workspaceModel.lists.favorites.some(isActive) ? "Remove from favorites" : "Add to favorites",
  );
}

export async function openWorkspaceNote(note: WorkspaceNote): Promise<void> {
  const owner = applicationSignal();
  const scope = authenticationSession.scope;
  const current = () => !owner.aborted && authenticationSession.isCurrent(scope);
  appState.element("workspace-dialog").close();
  try {
    await persistCurrentDraft();
    if (!current()) return;
    if (projectModel.active?.id === note.project) await navigateTo(note.id);
    else {
      await loadProjects();
      if (!current()) return;
      const url = new URL(window.location.href);
      url.searchParams.set("project", note.project);
      url.searchParams.set("document", note.id);
      url.hash = "";
      await switchProject(note.project, { url });
    }
  } catch (errorCause) {
    if (!current() || isAbortError(errorCause)) return;
    const error = errorContext(errorCause);
    documentNotice(`Could not open this note: ${error.message}`, "error");
  }
}

export function renderWorkspaceList(): void {
  const mode = appState.element("workspace-kind").value;
  if (mode !== "favorites" && mode !== "recent") {
    notice(appState.element("workspace-message"), "Unknown workspace view.", "error");
    return;
  }
  const notes = workspaceModel.lists[mode];
  const query = appState.element("workspace-filter").value.trim().toLowerCase();
  const matching = notes.filter((note) => `${note.title} ${note.path}`.toLowerCase().includes(query));
  appState.element("workspace-list").replaceChildren(
    ...matching.map((note) => {
      const row = document.createElement("div");
      const open = document.createElement("button");
      open.type = "button";
      open.className = "workspace-item-name";
      open.textContent = note.title;
      const detail = document.createElement("small");
      detail.textContent = `${projectModel.items.find((project) => project.id === note.project)?.name ?? "Project"} / ${note.path}`;
      open.append(detail);
      open.addEventListener("click", () => void openWorkspaceNote(note));
      row.append(open);
      if (mode === "favorites") {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "Remove";
        remove.addEventListener("click", () => {
          void changeWorkspace({ action: "favorite", project: note.project, id: note.id, value: false }).catch(
            (error) => {
              if (!isAbortError(error)) notice(appState.element("workspace-message"), error.message, "error");
            },
          );
        });
        row.append(remove);
      }
      return row;
    }),
  );
  notice(appState.element("workspace-message"), matching.length ? "" : "No matching workspace items.");
}

export async function openWorkspace(): Promise<void> {
  closeMenus();
  appState.element("workspace-filter").value = "";
  renderWorkspaceList();
  showDialog(appState.element("workspace-dialog"));
  await loadUserWorkspace();
}
