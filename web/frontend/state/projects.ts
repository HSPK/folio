import type { Project } from "../models/projects";

export interface ProjectRequest {
  readonly owner: symbol;
  readonly version: number;
  readonly order: number;
  readonly selection: symbol;
}

function ownedProject(project: Project): Project {
  return Object.freeze({
    ...project,
    pages: Object.freeze({ ...project.pages }),
    documentIds: project.documentIds ? Object.freeze({ ...project.documentIds }) : undefined,
    publicLinks: project.publicLinks
      ? Object.freeze(
          Object.fromEntries(
            Object.entries(project.publicLinks).map(([path, link]) => [path, Object.freeze({ ...link })]),
          ),
        )
      : undefined,
  });
}

export function createProjectModel() {
  let principal: string | null = null;
  let owner = Symbol("project-owner");
  let selection = Symbol("project-selection");
  let version = 0;
  let order = 0;
  let acceptedRead = 0;
  let items: readonly Project[] = Object.freeze([]);
  let index = new Map<string, Project>();
  let activeId: string | null = null;
  const reset = (next: string | null) => {
    principal = next;
    owner = Symbol("project-owner");
    selection = Symbol("project-selection");
    version = order = acceptedRead = 0;
    items = Object.freeze([]);
    index = new Map();
    activeId = null;
  };
  const get = (id: string) => index.get(id) ?? null;
  const readable = (request: ProjectRequest) =>
    request.owner === owner && request.version === version && request.order >= acceptedRead;
  const upsert = (project: Project) => {
    const next = ownedProject(project);
    items = Object.freeze(
      get(project.id) ? items.map((current) => (current.id === project.id ? next : current)) : [...items, next],
    );
    index.set(project.id, next);
    return next;
  };

  return {
    get principal() {
      return principal;
    },
    get items() {
      return items;
    },
    get active() {
      return activeId ? get(activeId) : null;
    },
    get selection() {
      return selection;
    },
    get,
    reset() {
      reset(null);
    },
    bindOwner(next: string | null) {
      if (next === principal) return false;
      reset(next);
      return true;
    },
    request(): ProjectRequest {
      return Object.freeze({ owner, version, order: ++order, selection });
    },
    replace(request: ProjectRequest, projects: readonly Project[]) {
      if (!readable(request)) return false;
      const ids = new Set(projects.map((project) => project.id));
      if (ids.size !== projects.length) throw new Error("The project catalog contains duplicate identities.");
      items = Object.freeze(projects.map(ownedProject));
      index = new Map(items.map((project) => [project.id, project]));
      acceptedRead = request.order;
      if (activeId && !get(activeId)) {
        activeId = null;
        selection = Symbol("project-selection");
      }
      return true;
    },
    commit(request: ProjectRequest, project: Project) {
      if (request.owner !== owner) throw new DOMException("The project account changed.", "AbortError");
      version++;
      acceptedRead = Math.max(acceptedRead, request.order);
      return upsert(project);
    },
    invalidateReadbacks(request: ProjectRequest) {
      if (request.owner === owner) version++;
    },
    acceptSession(request: ProjectRequest, project: Project) {
      if (request.owner !== owner || request.selection !== selection) return false;
      if (project.id !== activeId) throw new Error("The service returned a different project session.");
      if (!readable(request)) return false;
      acceptedRead = request.order;
      upsert(project);
      return true;
    },
    select(id: string | null, renew = false) {
      if (id !== null && !get(id)) throw new Error("This project is no longer accessible.");
      if (activeId !== id || renew) selection = Symbol("project-selection");
      activeId = id;
    },
  };
}

export type ProjectModel = ReturnType<typeof createProjectModel>;
export const projectModel = createProjectModel();
