import type { WorkspaceLists, WorkspaceSnapshot } from "../models/workspace-lists";

function emptyWorkspace(): WorkspaceLists {
  return Object.freeze({ favorites: Object.freeze([]), recent: Object.freeze([]) });
}

export function createWorkspaceModel() {
  let principal: string | null = null;
  let owner = Symbol("workspace-owner");
  let revision = 0;
  let order = 0;
  let acceptedOrder = 0;
  let loaded = false;
  let workspace = emptyWorkspace();

  const reset = (next: string | null) => {
    principal = next;
    owner = Symbol("workspace-owner");
    revision = order = acceptedOrder = 0;
    loaded = false;
    workspace = emptyWorkspace();
  };

  return {
    get principal() {
      return principal;
    },
    get revision() {
      return revision;
    },
    get loaded() {
      return loaded;
    },
    get lists() {
      return workspace;
    },
    bindOwner(next: string | null) {
      if (next === principal) return false;
      reset(next);
      return true;
    },
    reset() {
      reset(null);
    },
    beginRequest() {
      if (!principal) throw new Error("Workspace requests require an account owner.");
      return Object.freeze({ owner, order: ++order });
    },
    accept(ticket: { readonly owner: symbol; readonly order: number }, snapshot: WorkspaceSnapshot) {
      if (
        ticket.owner !== owner ||
        snapshot.revision < revision ||
        (snapshot.revision === revision && ticket.order < acceptedOrder)
      )
        return false;
      const copy = (notes: WorkspaceLists["recent"]) => Object.freeze(notes.map((note) => Object.freeze({ ...note })));
      workspace = Object.freeze({
        favorites: copy(snapshot.workspace.favorites),
        recent: copy(snapshot.workspace.recent),
      });
      revision = snapshot.revision;
      acceptedOrder = ticket.order;
      loaded = true;
      return true;
    },
  };
}

export type WorkspaceModel = ReturnType<typeof createWorkspaceModel>;
export const workspaceModel = createWorkspaceModel();
