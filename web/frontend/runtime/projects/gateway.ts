import { decodedProject, decodedProjects } from "../../api/contracts";
import type { ProjectChange } from "../../models/projects";
import { createProjectService } from "../../services/projects";
import { authenticationSession } from "../../state/authentication";
import { projectModel } from "../../state/projects";
import { requireValue } from "../../types/elements";
import { errorContext } from "../../types/errors";
import { api } from "../core/api";
import { applicationSignal, onApplicationDispose } from "../lifecycle";

let service: ReturnType<typeof createProjectService> | null = null;

export function initializeProjectGateway(changed: () => void): void {
  projectModel.reset();
  const owned = createProjectService({
    signal: applicationSignal(),
    scope: () => authenticationSession.scope,
    model: projectModel,
    read: (signal) => api("/api/projects", { decode: decodedProjects, signal, timeoutMs: 15000 }),
    async write(body, signal) {
      try {
        return await api("/api/projects", { decode: decodedProject, method: "POST", body, signal, timeoutMs: 15000 });
      } catch (cause) {
        const error = errorContext(cause);
        if (!signal.aborted && (error.network || error.status === 408 || !error.status || error.status >= 500))
          throw new Error(
            `The project change could not be confirmed and may already have been applied. Refresh before retrying. ${error.message}`,
            { cause },
          );
        throw cause;
      }
    },
    changed,
  });
  service = owned;
  const unsubscribe = authenticationSession.subscribe(owned.syncOwner);
  owned.syncOwner();
  onApplicationDispose(() => {
    unsubscribe();
    if (service === owned) {
      service = null;
      projectModel.reset();
    }
  });
}

export const loadProjectCatalog = () => requireValue(service, "Project service").load();
export const changeProject = (change: ProjectChange) => requireValue(service, "Project service").change(change);
