import { createButton } from "@folio/editor-runtime";
import { element } from "../../types/elements";
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
import { createListRow, documentNotice, notice } from "../core/dom";
import { confirmAction, showDialog } from "../dialogs/dialogs";
import { applicationLifetime, applicationSignal, listen, onApplicationDispose } from "../lifecycle";
import { buttonFeedback } from "../../../shared/feedback";
import { openSharing } from "../projects/projects";
import { publicShareUrl } from "./public";
let view: AbortController | null = null;
export function initializeSharingShares(): void {
  view = null;
  const dialog = element("shares-dialog");
  const cancel = () => {
    view?.abort();
    view = null;
  };
  onApplicationDispose(cancel);
  listen(dialog, "close", () => {
    if (!dialog.open) cancel();
  });
  listen(element("shares-open"), "click", () => void openShareCenter());
  listen(element("shares-close"), "click", () => element("shares-dialog").close());
}
async function openShareCenter(): Promise<void> {
  const owner = applicationSignal();
  const scope = authenticationSession.scope;
  view?.abort();
  const controller = new AbortController();
  view = controller;
  const signal = AbortSignal.any([owner, scope.signal, controller.signal]);
  const current = () => !signal.aborted && view === controller && authenticationSession.isCurrent(scope);
  closeMenus();
  const dialog = element("shares-dialog");
  showDialog(dialog);
  notice(element("shares-message"), "Loading public links…");
  try {
    const links = await api("/api/shares", {
      decode: decodedShares,
      signal,
      timeoutMs: 15000,
    });
    if (!current()) return;
    element("shares-list").replaceChildren(
      ...links.map((link: PublicLink) => {
        const row = createListRow(
          `${link.projectName} / ${link.path}`,
          `${link.access === "edit" ? "Anonymous editing" : "Read only"} · ${link.passwordRequired ? "Password protected" : "No password"} · ${
            link.expiresAt
              ? `${link.expiresAt <= Date.now() ? "Expired" : "Expires"} ${new Date(link.expiresAt).toLocaleString()}`
              : "No expiration"
          }`,
        );
        const manage = createButton({ label: "Manage" });
        manage.addEventListener("click", async () => {
          let handedOff = false;
          try {
            await loadProjects();
            if (!current()) return;
            const project = projectModel.items.find((project) => project.id === link.project);
            if (!project?.owned) throw new Error("Project unavailable");
            dialog.close();
            handedOff = true;
            await openSharing(project, link.path, link.document);
          } catch (errorCause) {
            if (isAbortError(errorCause) || owner.aborted || !authenticationSession.isCurrent(scope)) return;
            const error = errorContext(errorCause);
            if (handedOff) documentNotice(`Open failed: ${error.message}`, "error");
            else if (current()) notice(element("shares-message"), error.message, "error");
          }
        });

        const copy = createButton({ label: "Copy" });
        copy.addEventListener("click", async () => {
          if (!current()) return;
          try {
            await copyPlainText(publicShareUrl(link.token));
            if (current()) buttonFeedback(copy, "Copied", applicationLifetime());
          } catch (errorCause) {
            if (!current()) return;
            const error = errorContext(errorCause);
            notice(element("shares-message"), error.message, "error");
          }
        });

        const revoke = createButton({ label: "Revoke" });
        revoke.addEventListener("click", async () => {
          if (!current()) return;
          if (
            !(await confirmAction(`Revoke the public link for ${link.path}?`, {
              label: "Revoke link",
              signal,
              tone: "destructive",
            }))
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
            notice(element("shares-message"), error.message, "error");
            revoke.disabled = false;
          }
        });

        row.append(manage, copy, revoke);
        return row;
      }),
    );
    notice(element("shares-message"), links.length ? "" : "No public links");
  } catch (errorCause) {
    if (!current() || isAbortError(errorCause)) return;
    const error = errorContext(errorCause);
    notice(element("shares-message"), error.message, "error");
  }
}
import { copyPlainText } from "../../../shared/clipboard";
