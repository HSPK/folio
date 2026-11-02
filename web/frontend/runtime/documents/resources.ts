import { projectModel } from "../../state/projects";
import { authenticationSession } from "../../state/authentication";
import { documentSession } from "../../state/document";
import { decodedResource } from "../../api/contracts";
import { isResourceId, normalizeNotePath } from "@folio/model";
import { notePathFromTitle } from "@folio/workspace-model";
import { shell } from "../../state/shell";
import type { DocumentPermissions, ResourceEntry, ResourceKind } from "../../types/domain";
import { requireValue } from "../../types/elements";
import { isRecord } from "../../types/guards";
import { api } from "../core/api";
import { appState } from "../core/bootstrap";
import { ApiError, documentNotice } from "../core/dom";
import { openNewNote, refreshNewNoteHint } from "../navigation/files";

import { projectCanCreate } from "../projects/permissions";
import { publicState } from "../sharing/public";
import { refreshPreviewLinks } from "./preview";
import { validatedDocumentPermissions } from "../../api/contracts";
export { validatedDocumentPermissions } from "../../api/contracts";
import { applicationSignal, onApplicationDispose } from "../lifecycle";
import { errorContext } from "../../types/errors";
class ResourceState {
  documentPermissions!: DocumentPermissions | null;
  resourceIndex!: Map<string, ResourceEntry>;
  resourceLocations!: Map<string, ResourceEntry>;
  resolvingResourceLinks!: Set<string>;
  unavailableResourceLinks!: Map<string, number>;
  resourceLocation!: (project: string, path: string) => string;
  refreshFrame: number | null = null;
}
export const resourceState = new ResourceState();
export function initializeDocumentsResources(): void {
  resourceState.documentPermissions = null;
  resourceState.resourceIndex = new Map();
  resourceState.resourceLocations = new Map();
  resourceState.resolvingResourceLinks = new Set();
  resourceState.unavailableResourceLinks = new Map();
  resourceState.resourceLocation = (project, path) => `${project}\0${normalizeNotePath(path)}`;
  resourceState.refreshFrame = null;
  onApplicationDispose(() => {
    if (resourceState.refreshFrame !== null) cancelAnimationFrame(resourceState.refreshFrame);
    resourceState.refreshFrame = null;
  });
}
export function acceptDocumentPermissions(value: unknown) {
  const next = validatedDocumentPermissions(value);
  const previous = resourceState.documentPermissions;
  const changed =
    !previous || (["writable", "collaborative", "owner"] as const).some((key) => previous[key] !== next[key]);
  resourceState.documentPermissions = next;
  if (publicState.publicView) publicState.publicWritable = next.writable;
  return changed;
}
export function documentReadUrl(id: string) {
  const source = !publicState.publicView && ["editor", "rich"].includes(shell.view);
  return `/api/document?id=${encodeURIComponent(id)}${source ? "&render=source" : ""}`;
}
export function rememberResource(
  value: unknown,
  project: string = projectModel.active?.id ?? "local",
  kind: ResourceKind = "document",
) {
  if (!isRecord(value) || !isResourceId(value.id) || typeof value.path !== "string") return;
  const resourceKind = value.kind === "file" ? "document" : (value.kind ?? kind);
  if (resourceKind !== "document" && resourceKind !== "directory" && resourceKind !== "asset") {
    throw new ApiError("The service returned an unrecognized resource kind.");
  }
  const resource: ResourceEntry = {
    id: value.id,
    path: value.path,
    project: typeof value.project === "string" ? value.project : project,
    kind: resourceKind,
  };
  const previous = resourceState.resourceIndex.get(resource.id);
  if (previous) resourceState.resourceLocations.delete(resourceState.resourceLocation(previous.project, previous.path));
  resourceState.resourceIndex.set(resource.id, resource);
  resourceState.resourceLocations.set(resourceState.resourceLocation(resource.project, resource.path), resource);
  resourceState.unavailableResourceLinks.delete(resourceState.resourceLocation(resource.project, resource.path));
  return !previous || previous.path !== resource.path || previous.project !== resource.project;
}
export function rememberResources(payload: unknown, project: string): void {
  if (!isRecord(payload)) return;
  let changed = rememberResource(payload, project);
  for (const file of Array.isArray(payload.files) ? payload.files : [])
    changed = rememberResource(file, project) || changed;
  for (const directory of Array.isArray(payload.directories) ? payload.directories : [])
    changed = rememberResource(directory, project, "directory") || changed;
  for (const result of Array.isArray(payload.results) ? payload.results : []) {
    changed =
      rememberResource(result, isRecord(result) && typeof result.project === "string" ? result.project : project) ||
      changed;
  }
  for (const reference of Array.isArray(payload.references) ? payload.references : []) {
    if (!isRecord(reference)) continue;
    const referenceProject = typeof reference.project === "string" ? reference.project : project;
    changed = rememberResource(reference, referenceProject) || changed;
    if (typeof reference.source === "string") {
      const resource = typeof reference.id === "string" ? resourceState.resourceIndex.get(reference.id) : undefined;
      if (resource)
        resourceState.resourceLocations.set(
          resourceState.resourceLocation(referenceProject, reference.source),
          resource,
        );
    }
  }
  if (isRecord(payload.workspace)) {
    for (const note of [
      ...(Array.isArray(payload.workspace.favorites) ? payload.workspace.favorites : []),
      ...(Array.isArray(payload.workspace.recent) ? payload.workspace.recent : []),
    ]) {
      changed =
        rememberResource(note, isRecord(note) && typeof note.project === "string" ? note.project : project) || changed;
    }
  }
  if (payload?.document && typeof payload.document === "object")
    changed = rememberResource(payload.document, project) || changed;
  if (changed && resourceState.refreshFrame === null)
    resourceState.refreshFrame = requestAnimationFrame(() => {
      resourceState.refreshFrame = null;
      appState.inlineEditor.refreshLinks?.();
      refreshPreviewLinks();
    });
}
export function requestResourceLink(path: string, kind: ResourceKind): void {
  const owner = applicationSignal();
  const project = documentSession.current?.project ?? projectModel.active?.id ?? "local";
  const key = resourceState.resourceLocation(project, path);
  if (resourceState.resolvingResourceLinks.has(key) || resourceState.unavailableResourceLinks.has(key)) return;
  resourceState.resolvingResourceLinks.add(key);
  const current = documentSession.id;
  void api("/api/resources/resolve", {
    decode: decodedResource,
    method: "POST",
    body: { path, kind, document: documentSession.current?.id ?? null },
  })
    .then((resource) => {
      resourceState.resourceLocations.set(key, resource);
      if (current === documentSession.id) {
        appState.inlineEditor.refreshLinks?.();
        refreshPreviewLinks();
      }
    })
    .catch((cause: unknown) => {
      if (owner.aborted) return;
      const error = errorContext(cause);
      resourceState.unavailableResourceLinks.set(key, error.status);
      if (current === documentSession.id) {
        appState.inlineEditor.refreshLinks?.();
        if (![403, 404].includes(error.status))
          documentNotice(
            `Could not load a linked resource. Refresh the file list to retry. ${error.message}`,
            "warning",
          );
      }
    })
    .finally(() => {
      if (!owner.aborted) resourceState.resolvingResourceLinks.delete(key);
    });
}
export function linkedNotePath(value: string) {
  if (!value?.startsWith("/") || value.startsWith("//")) return null;
  try {
    return decodeURIComponent(new URL(value, window.location.href).pathname.slice(1));
  } catch {
    return null;
  }
}
export function canCreateLinkedNote(value: string) {
  const path = linkedNotePath(value);
  if (!path) return false;
  if (
    publicState.publicView ||
    !projectCanCreate() ||
    (authenticationSession.mode === "users" && !projectModel.active?.owned)
  )
    return false;
  const key = resourceState.resourceLocation(
    documentSession.current?.project ?? projectModel.active?.id ?? "local",
    path,
  );
  if (resourceState.unavailableResourceLinks.get(key) !== 404 || !/\.md$/i.test(path)) return false;
  const parts = path.split("/");
  const title = requireValue(parts.pop()).replace(/\.md$/i, "");
  try {
    return notePathFromTitle(title, parts.join("/")) === path;
  } catch {
    return false;
  }
}
export async function openLinkedNote(value: string): Promise<void> {
  if (!canCreateLinkedNote(value)) {
    documentNotice("This linked note cannot be created here.", "warning");
    return;
  }
  const path = linkedNotePath(value);
  const parts = requireValue(path).split("/");
  const title = requireValue(parts.pop()).replace(/\.md$/i, "");
  if (!(await openNewNote(parts.join("/")))) return;
  appState.ui.newTitle.value = title;
  refreshNewNoteHint();
}
export async function documentResource(value: string | null, signal?: AbortSignal) {
  if (value === null) throw new ApiError("A document identity or path is required.");
  if (isResourceId(value)) {
    const resource = resourceState.resourceIndex.get(value);
    if (resource) return resource;
    return api(`/api/resource?id=${encodeURIComponent(value)}`, {
      decode: decodedResource,
      signal,
    });
  }
  const project = documentSession.current?.project ?? projectModel.active?.id ?? "local";
  const known = resourceState.resourceLocations.get(resourceState.resourceLocation(project, value));
  if (known) return known;
  return api("/api/resources/resolve", {
    decode: decodedResource,
    method: "POST",
    signal,
    body: { path: value, kind: "document", document: documentSession.current?.id ?? null },
  });
}
export function currentResourceId(path: string, kind = "document") {
  if (isResourceId(path)) return path;
  const resource = resourceState.resourceLocations.get(
    resourceState.resourceLocation(documentSession.current?.project ?? projectModel.active?.id ?? "local", path),
  );
  if (!resource || resource.kind !== kind)
    throw new ApiError("This resource has no current identity. Refresh the project before continuing.");
  return resource.id;
}
