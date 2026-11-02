export interface WorkspaceNote {
  readonly id: string;
  readonly project: string;
  readonly path: string;
  readonly title: string;
}

export interface WorkspaceLists {
  readonly favorites: readonly WorkspaceNote[];
  readonly recent: readonly WorkspaceNote[];
}

export interface WorkspaceSnapshot {
  readonly revision: number;
  readonly workspace: WorkspaceLists;
}

export type WorkspaceAction =
  | { readonly action: "visit"; readonly project: string; readonly id: string }
  | { readonly action: "favorite"; readonly project: string; readonly id: string; readonly value: boolean };

export function sameWorkspaceNote(note: WorkspaceNote, project: string, id: string) {
  return note.project === project && note.id === id;
}

export function restoredWorkspaceNote(
  workspace: WorkspaceLists,
  requested: string | null,
  saved: { readonly project: string; readonly id: string } | null,
) {
  const recent = workspace.recent.filter((note) => !requested || note.project === requested);
  return (
    [...recent, ...workspace.favorites].find(
      (note) => saved && (!requested || note.project === requested) && sameWorkspaceNote(note, saved.project, saved.id),
    ) ??
    recent[0] ??
    null
  );
}
