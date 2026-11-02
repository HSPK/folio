import { loadProjectCatalog as loadProjects } from "../projects/gateway";
import { projectModel } from "../../state/projects";
import { decodedShares } from "../../api/contracts";
import { authenticationSession } from "../../state/authentication";
import { isAbortError } from "../../api/error";
import { changeProject } from "../projects/gateway";
import type { PublicLink } from "../../types/domain";
import { errorContext } from "../../types/errors";
import { closeMenus } from "../accounts/authentication";
import { api } from "../core/api";
import { appState } from "../core/bootstrap";
import { documentNotice, notice } from "../core/dom";
import { confirmAction, showDialog } from "../dialogs/dialogs";
import { applicationSignal, listen, onApplicationDispose } from "../lifecycle";
import { openSharing } from "../projects/projects";
import { publicShareUrl } from "./public";
let view: AbortController | null = null;
export function initializeSharingShares(): void {
  view = null;
  const dialog = appState.element("shares-dialog");
  const cancel = () => {
    view?.abort();
    view = null;
  };
  onApplicationDispose(cancel);
  listen(dialog, "close", () => {
    if (!dialog.open) cancel();
  });
  listen(appState.element("shares-open"), "click", () => void openShareCenter());
  listen(appState.element("shares-close"), "click", () => appState.element("shares-dialog").close());
}
export async function openShareCenter(): Promise<void> {
  const owner = applicationSignal();
  const scope = authenticationSession.scope;
  view?.abort();
  const controller = new AbortController();
  view = controller;
  const signal = AbortSignal.any([owner, scope.signal, controller.signal]);
  const current = () => !signal.aborted && view === controller && authenticationSession.isCurrent(scope);
  closeMenus();
  const dialog = appState.element("shares-dialog");
  showDialog(dialog);
  notice(appState.element("shares-message"), "Loading public links…");
  try {
    const links = await api("/api/shares", {
      decode: decodedShares,
      signal,
      timeoutMs: 15000,
    });
    if (!current()) return;
    appState.element("shares-list").replaceChildren(
      ...links.map((link: PublicLink) => {
        const row = document.createElement("div");
        const name = document.createElement("span");
        name.className = "workspace-item-name";
        name.textContent = `${link.projectName} / ${link.path}`;
        const details = document.createElement("small");
        details.textContent = `${link.access === "edit" ? "Anonymous editing" : "Read only"} · ${link.passwordRequired ? "Password protected" : "No password"} · ${
          link.expiresAt
            ? `${link.expiresAt <= Date.now() ? "Expired" : "Expires"} ${new Date(link.expiresAt).toLocaleString()}`
            : "No expiration"
        }`;
        name.append(details);
        const manage = document.createElement("button");
        manage.type = "button";
        manage.textContent = "Manage";
        manage.addEventListener("click", async () => {
          let handedOff = false;
          try {
            await loadProjects();
            if (!current()) return;
            const project = projectModel.items.find((project) => project.id === link.project);
            if (!project?.owned) throw new Error("This project is no longer available.");
            dialog.close();
            handedOff = true;
            await openSharing(project, link.path, link.document);
          } catch (errorCause) {
            if (isAbortError(errorCause) || owner.aborted || !authenticationSession.isCurrent(scope)) return;
            const error = errorContext(errorCause);
            if (handedOff) documentNotice(`Could not open sharing settings: ${error.message}`, "error");
            else if (current()) notice(appState.element("shares-message"), error.message, "error");
          }
        });
        const copy = document.createElement("button");
        copy.type = "button";
        copy.textContent = "Copy";
        copy.addEventListener("click", async () => {
          if (!current()) return;
          try {
            await navigator.clipboard.writeText(publicShareUrl(link.token));
            if (current()) documentNotice("");
          } catch (errorCause) {
            if (!current()) return;
            const error = errorContext(errorCause);
            notice(appState.element("shares-message"), error.message, "error");
          }
        });
        const revoke = document.createElement("button");
        revoke.type = "button";
        revoke.textContent = "Revoke";
        revoke.addEventListener("click", async () => {
          if (!current()) return;
          if (
            !(await confirmAction(
              `Revoke the public link for ${link.path}? Signed-in user permissions will be retained.`,
              { label: "Revoke link", signal },
            ))
          )
            return;
          revoke.disabled = true;
          try {
            await changeProject({
              action: "revokePublic",
              id: link.project,
              document: link.document,
            });
            if (current() && dialog.open) await openShareCenter();
          } catch (errorCause) {
            if (!current() || isAbortError(errorCause)) return;
            const error = errorContext(errorCause);
            notice(appState.element("shares-message"), error.message, "error");
            revoke.disabled = false;
          }
        });
        row.append(name, manage, copy, revoke);
        return row;
      }),
    );
    notice(appState.element("shares-message"), links.length ? "" : "You have no public document links.");
  } catch (errorCause) {
    if (!current() || isAbortError(errorCause)) return;
    const error = errorContext(errorCause);
    notice(appState.element("shares-message"), error.message, "error");
  }
}
