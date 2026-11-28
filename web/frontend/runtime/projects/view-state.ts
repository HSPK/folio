import type { Project } from "@folio/model";

interface ProjectViewState {
  projectCreating: boolean;
  sharingTarget: { project: Project; path: string | null; document: string | null } | null;
}

export const projectViewState: ProjectViewState = { projectCreating: false, sharingTarget: null };
