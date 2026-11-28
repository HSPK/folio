import { loadProjectCatalog as loadProjects } from "../projects/gateway";
import { projectModel } from "../../state/projects";
import { authenticationSession } from "../../state/authentication";
import { documentSession } from "../../state/document";
import { decodedWorkspace } from "../../api/contracts";
import { restoredWorkspaceNote, sameWorkspaceNote, type WorkspaceAction, isResourceId } from "@folio/model";
import { createWorkspaceService } from "../../services/workspace";
import { workspaceModel } from "../../state/workspace";
import type { WorkspaceNote } from "../../types/domain";
import { element, requireValue } from "../../types/elements";
import { errorContext } from "../../types/errors";
import { isRecord } from "../../types/guards";
import { isAbortError } from "../../api/error";
import { closeMenus, connectionFailure, handleAuthenticationFailure } from "../accounts/authentication";
import { isConnectionLoss } from "../core/recovery";
import { api } from "../core/api";
import { appState } from "../core/bootstrap";
import { createListRow, documentNotice, notice, setText } from "../core/dom";
import { readLayoutPreference, storeLayoutPreference } from "../core/layout";
import { showDialog } from "../dialogs/dialogs";
import { createIcon, createButton } from "@folio/editor-runtime";
import { persistCurrentDraft } from "../documents/drafts";
import { commitUrl, navigateTo } from "../documents/navigation";
import { documentReadUrl, entryResourceId } from "../documents/resources";
import { activePanelPath } from "../../state/library";
import { openFilePanelResource } from "../navigation/panels";
import { applicationSignal, listen, onApplicationDispose } from "../lifecycle";
import { projectStorageKey, switchProject } from "../projects/projects";

let workspaceService: ReturnType<typeof createWorkspaceService> | null = null;
let workspaceControlSignature: string | null = null;
export function initializeWorkspaceWorkspace(): void {
  const dialog = element("workspace-dialog");
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
  listen(element("workspace-open"), "click", () => void openWorkspace());
  listen(element("workspace-close"), "click", () => dialog.close());
  listen(element("workspace-kind"), "change", renderWorkspaceList);
  listen(element("workspace-filter"), "input", renderWorkspaceList);
  listen(element("workspace-favorite"), "click", async () => {
    closeMenus();
    if (!projectModel.active || !documentSession.current) return;
    const project = projectModel.active.id;
    const id = documentSession.current.id;
    const value = !workspaceModel.lists.favorites.some((note) => sameWorkspaceNote(note, project, id));
    try {
      await changeWorkspace({ action: "favorite", project, id, value });
      if (projectModel.active?.id === project && documentSession.current?.id === id)
        documentNotice(value ? "Added to favorites" : "Removed from favorites", "success");
    } catch (errorCause) {
      if (isAbortError(errorCause)) return;
      const error = errorContext(errorCause);
      documentNotice(`Workspace update failed: ${error.message}`, "error");
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
    !element("auth-screen").hidden ||
    authenticationSession.scope.signal.aborted
  )
    return;
  try {
    await requireValue(workspaceService, "Account workspace").load();
  } catch (errorCause) {
    if (isAbortError(errorCause)) return;
    const error = errorContext(errorCause);

    if (isConnectionLoss(error)) connectionFailure(error);
    else if (!handleAuthenticationFailure(error)) documentNotice(`Workspace load failed: ${error.message}`, "warning");
  }
}

export async function changeWorkspace(action: WorkspaceAction) {
  return requireValue(workspaceService, "Account workspace").change(action);
}

export function noteVisited(): void {
  if (authenticationSession.mode === "launchToken") {
    storeLayoutPreference(activeWorkspaceKey(), "null");
    return;
  }
  if (authenticationSession.mode !== "users" || !projectModel.active || !documentSession.current) return;
  const note = { project: projectModel.active.id, id: documentSession.current.id };
  if (documentSession.resourceId) {
    try {
      sessionStorage.setItem(
        "folio.start.note",
        JSON.stringify({
          ...note,
          reader: authenticationSession.user?.username,
          page: window.location.pathname,
          source: documentReadUrl(note.id).endsWith("&render=source"),
        }),
      );
    } catch {
      // Read-ahead is optional.
    }
  }
  storeLayoutPreference(activeWorkspaceKey(), JSON.stringify(note));
  void changeWorkspace({ action: "visit", ...note }).catch((error) => {
    if (!isAbortError(error)) documentNotice(`Recents update failed: ${error.message}`, "warning");
  });
}

export async function fileVisited(path: string, resourceId?: string): Promise<void> {
  if (authenticationSession.mode !== "launchToken" && (authenticationSession.mode !== "users" || !projectModel.active))
    return;
  const selection = projectModel.selection,
    project = projectModel.active?.id ?? "local";
  const url = new URL("/", appState.committedUrl);
  if (authenticationSession.mode === "users") url.searchParams.set("project", project);
  if (resourceId) url.searchParams.set("asset", resourceId);
  commitUrl(url, "replace");
  storeLayoutPreference(
    activeWorkspaceKey(),
    JSON.stringify({ project, path, kind: "asset", ...(resourceId ? { id: resourceId } : {}) }),
  );
  try {
    sessionStorage.removeItem("folio.start.note");
  } catch {
    // Read-ahead is optional.
  }
  try {
    const id = resourceId ?? (await entryResourceId(path));
    if (selection !== projectModel.selection || activePanelPath() !== path) return;
    url.searchParams.set("asset", id);
    commitUrl(url, "replace");
    storeLayoutPreference(activeWorkspaceKey(), JSON.stringify({ project, id, path, kind: "asset" }));
    if (authenticationSession.mode === "users") await changeWorkspace({ action: "visit", project, id });
  } catch (cause) {
    if (selection === projectModel.selection && !isAbortError(cause))
      documentNotice(`Recents update failed: ${errorContext(cause).message}`, "warning");
  }
}

export function rememberedFilePanel(): { project: string; path: string; id?: string } | null {
  if (authenticationSession.mode !== "users" && authenticationSession.mode !== "launchToken") return null;
  const url = new URL(appState.committedUrl);
  if (url.searchParams.has("document") || url.searchParams.has("asset")) return null;
  try {
    const saved: unknown = JSON.parse(readLayoutPreference(activeWorkspaceKey()) ?? "null");
    const project =
      authenticationSession.mode === "launchToken"
        ? "local"
        : (url.searchParams.get("project") ?? projectModel.active?.id ?? readLayoutPreference(projectStorageKey()));
    if (
      isRecord(saved) &&
      saved.kind === "asset" &&
      saved.project === project &&
      typeof saved.project === "string" &&
      typeof saved.path === "string" &&
      saved.path.length > 0
    ) {
      return { project: saved.project, path: saved.path, ...(isResourceId(saved.id) ? { id: saved.id } : {}) };
    }
  } catch {
    /* An incomplete preference must not prevent connecting. */
  }
  return null;
}

export function restoreActiveWorkspaceNote(): void {
  if (rememberedFilePanel()) return;
  if (!workspaceModel.loaded || documentSession.current || authenticationSession.mode !== "users") return;
  const url = new URL(appState.committedUrl);
  if (url.searchParams.has("document") || url.searchParams.has("asset")) return;
  const remembered = projectModel.active?.id ?? readLayoutPreference(projectStorageKey());
  const requested = url.searchParams.get("project") ?? (remembered && projectModel.get(remembered) ? remembered : null);
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
  url.searchParams.set(/\.(md|markdown)$/i.test(note.path) ? "document" : "asset", note.id);
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
    element("workspace-favorite"),
    workspaceModel.lists.favorites.some(isActive) ? "Remove from favorites" : "Add to favorites",
  );
}

async function openWorkspaceNote(note: WorkspaceNote): Promise<void> {
  const owner = applicationSignal();
  const scope = authenticationSession.scope;
  const current = () => !owner.aborted && authenticationSession.isCurrent(scope);
  element("workspace-dialog").close();
  try {
    await persistCurrentDraft();
    if (!current()) return;
    if (projectModel.active?.id === note.project) {
      if (/\.(md|markdown)$/i.test(note.path)) await navigateTo(note.id);
      else await openFilePanelResource(note.id);
    } else {
      await loadProjects();
      if (!current()) return;
      const url = new URL(appState.committedUrl);
      url.searchParams.set("project", note.project);
      url.searchParams.delete("asset");
      url.searchParams.delete("document");
      url.searchParams.set(/\.(md|markdown)$/i.test(note.path) ? "document" : "asset", note.id);
      url.hash = "";
      await switchProject(note.project, { url });
    }
  } catch (errorCause) {
    if (!current() || isAbortError(errorCause)) return;
    const error = errorContext(errorCause);
    documentNotice(`Open failed: ${error.message}`, "error");
  }
}

function renderWorkspaceList(): void {
  const mode = element("workspace-kind").value;
  if (mode !== "favorites" && mode !== "recent") {
    notice(element("workspace-message"), "Unknown workspace view", "error");
    return;
  }
  const notes = workspaceModel.lists[mode];
  const query = element("workspace-filter").value.trim().toLowerCase();
  const matching = notes.filter((note) => `${note.title} ${note.path}`.toLowerCase().includes(query));
  element("workspace-list").replaceChildren(
    ...matching.map((note) => {
      // Untitled notes are listed by file name; the full path stays on the detail line.
      const row = createListRow(
        note.title === note.path ? (note.path.split("/").at(-1) ?? note.title) : note.title,
        `${projectModel.items.find((project) => project.id === note.project)?.name ?? "Project"} / ${note.path}`,
        () => void openWorkspaceNote(note),
      );
      row.prepend(createIcon("file"));
      if (mode === "favorites") {
        const remove = createButton({ label: "Remove" });
        remove.addEventListener("click", () => {
          void changeWorkspace({ action: "favorite", project: note.project, id: note.id, value: false }).catch(
            (error) => {
              if (!isAbortError(error)) notice(element("workspace-message"), error.message, "error");
            },
          );
        });

        row.append(remove);
      }
      return row;
    }),
  );
  notice(
    element("workspace-message"),
    matching.length ? "" : query ? "No matching notes" : mode === "favorites" ? "No favorites yet" : "No recent notes",
  );
}

export async function openWorkspace(): Promise<void> {
  closeMenus();
  element("workspace-filter").value = "";
  renderWorkspaceList();
  showDialog(element("workspace-dialog"));
  await loadUserWorkspace();
}
