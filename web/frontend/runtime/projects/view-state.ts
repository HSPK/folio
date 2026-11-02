import type { Project } from "../../models/projects";

interface ProjectViewState {
  projectCreating: boolean;
  sharingTarget: { project: Project; path: string | null; document: string | null } | null;
}

export const projectViewState: ProjectViewState = { projectCreating: false, sharingTarget: null };
