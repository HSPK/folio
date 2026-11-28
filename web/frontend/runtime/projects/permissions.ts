import { projectModel } from "../../state/projects";
import { authenticationSession } from "../../state/authentication";
import { documentSession } from "../../state/document";
import { resourceState } from "../documents/resources";
import { publicState } from "../sharing/public";

export function projectWritable(path: string | undefined = documentSession.current?.path) {
  if (path === documentSession.current?.path && resourceState.documentPermissions)
    return resourceState.documentPermissions.writable;
  if (publicState.publicView) return publicState.publicWritable;
  if (authenticationSession.mode !== "users") return true;
  return (
    projectModel.active?.owned ||
    ((path ? projectModel.active?.pages[path] : undefined) ?? projectModel.active?.access) === "edit"
  );
}

export function projectCanCreate() {
  if (publicState.publicView) return false;
  return (
    authenticationSession.mode !== "users" ||
    Boolean(projectModel.active && (projectModel.active.owned || projectModel.active.access === "edit"))
  );
}

export function projectOwns() {
  return !publicState.publicView && (authenticationSession.mode !== "users" || Boolean(projectModel.active?.owned));
}

export function projectCanMove(path: string, kind: "file" | "directory", destination: string) {
  if (!projectCanCreate() || !projectWritable(path) || !projectWritable(destination)) return false;
  const project = projectModel.active;
  if (authenticationSession.mode !== "users" || !project) return true;
  const exceptions = Object.keys(project.pages);
  if (kind === "directory" && !project.owned && exceptions.length) return false;
  return !exceptions.some((page) => page === destination || page.startsWith(`${destination}/`));
}
