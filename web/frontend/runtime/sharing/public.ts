import { projectViewState as projectState } from "../projects/view-state";
import { projectModel } from "../../state/projects";
import { authenticationSession } from "../../state/authentication";
import { documentSession } from "../../state/document";
import { decodedPublicSession } from "../../api/contracts";
import { isResourceId, makeNoteUrl } from "@folio/model";
import { requireValue } from "../../types/elements";
import { errorContext } from "../../types/errors";
import { hideAuthentication, refreshControls, setSidebar } from "../accounts/authentication";
import { collaborationState, connectCollaboration } from "../collaboration/collaboration";
import { api } from "../core/api";
import { stopAppearancePolling } from "../core/appearance";
import { appState } from "../core/bootstrap";
import { ApiError, notice, setText } from "../core/dom";
import { showDialog } from "../dialogs/dialogs";
import { navigateTo } from "../documents/navigation";
import { rememberResource } from "../documents/resources";
import { listen } from "../lifecycle";
import { confirmProjectAction, projectDialogState, projectFormState } from "../projects/dialog";
import { saveSharing, updateProjectControls } from "../projects/projects";
class PublicState {
  publicView!: boolean;
  publicToken!: string | null;
  publicWritable!: boolean;
  publicApiPaths!: Set<string>;
}
export const publicState = new PublicState();
export function initializeSharingPublic(): void {
  publicState.publicView = window.location.pathname === "/share";
  publicState.publicToken = publicState.publicView ? new URL(window.location.href).searchParams.get("share") : null;
  publicState.publicWritable = false;
  publicState.publicApiPaths = new Set([
    "session",
    "document",
    "preview",
    "images",
    "resource",
    "resources/resolve",
    "collaboration/join",
    "collaboration/presence",
  ]);
  listen(appState.element("public-password-cancel"), "click", () => appState.element("public-password-dialog").close());
  listen(appState.element("public-password-form"), "submit", async (event) => {
    event.preventDefault();
    appState.element("public-password-submit").disabled = true;
    try {
      await connectPublic(appState.element("public-password").value);
    } finally {
      appState.element("public-password-submit").disabled = false;
      appState.element("public-password").value = "";
    }
  });
  listen(appState.element("sharing-form"), "input", refreshSharingCopy);
  listen(appState.element("sharing-form"), "change", refreshSharingCopy);
  listen(appState.element("sharing-level"), "change", renderPublicShareFields);
  listen(appState.element("sharing-reset-link"), "click", async () => {
    if (
      !(await confirmProjectAction(
        "Reset this public link? Existing links and guest connections will stop working.",
        "Reset link",
      ))
    )
      return;
    await saveSharing(true);
  });
  listen(appState.element("sharing-clear-password"), "change", () => {
    appState.element("sharing-password").disabled = appState.element("sharing-clear-password").checked;
    if (appState.element("sharing-clear-password").checked) appState.element("sharing-password").value = "";
  });
}
export function scopedApiPath(path: string, headers: Record<string, string>) {
  if (publicState.publicView) {
    const url = new URL(path, window.location.href);
    const name = url.pathname.replace(/^\/api\/(?:public\/)?/, "");
    if (!publicState.publicApiPaths.has(name))
      throw new ApiError("This action is unavailable from a public document.", 403);
    url.pathname = `/api/public/${name}`;
    headers["X-Folio-Share"] = publicState.publicToken ?? "";
    delete headers.Authorization;
    return url.pathname + url.search;
  }
  if (
    projectModel.active &&
    !/^\/api\/(?:auth|admin|projects|preferences|appearance|resource)(?:\/|[?]|$)/.test(path)
  ) {
    headers["X-Folio-Project"] = projectModel.active.id;
  }
  if (authenticationSession.mode === "users" && authenticationSession.user?.id)
    headers["X-Folio-User"] = authenticationSession.user.id;
  return path;
}
export async function connectPublic(password?: string): Promise<void> {
  appState.token = null;
  authenticationSession.initialize("public");
  hideAuthentication();
  stopAppearancePolling();
  notice(appState.ui.treeMessage, "");
  notice(appState.ui.treeLimit, "");
  setSidebar(false);
  updateProjectControls();
  appState.connectionState = "connecting";
  refreshControls();
  try {
    if (!/^[a-f0-9]{64}$/i.test(publicState.publicToken ?? ""))
      throw new ApiError("Open a valid public document link.", 403);
    const session = await api("/api/public/session", {
      decode: decodedPublicSession,
      method: "POST",
      ...(password !== undefined ? { body: { password } } : {}),
    });
    if (session.passwordRequired) {
      publicState.publicWritable = false;
      appState.connectionState = "error";
      requestPublicPassword();
      return;
    }
    if (!isResourceId(session.id) || typeof session.path !== "string" || typeof session.writable !== "boolean") {
      throw new ApiError("The service returned an incomplete public document.");
    }
    publicState.publicWritable = session.writable;
    appState.element("public-password-dialog").close();
    appState.element("public-password").value = "";
    appState.currentRoot = "Public document";
    appState.connectionState = "ready";
    if (!documentSession.current) {
      rememberResource(session, session.project ?? "local");
      const url = makeNoteUrl(window.location.href, session.id, window.location.hash);
      await navigateTo(session.id, url.hash, { url, mode: "replace" });
    } else {
      notice(appState.ui.connectionMessage, "");
      if (collaborationState.collaboration) await connectCollaboration(collaborationState.collaboration);
    }
  } catch (errorCause) {
    const error = errorContext(errorCause);
    publicState.publicWritable = false;
    appState.connectionState = "error";
    notice(appState.ui.connectionMessage, error.message, "error");
    if (error.status === 401) {
      requestPublicPassword();
      notice(appState.element("public-password-error"), error.message, "error");
    }
  } finally {
    refreshControls();
  }
}
export function requestPublicPassword(): void {
  notice(appState.element("public-password-error"), "");
  showDialog(appState.element("public-password-dialog"));
  appState.element("public-password").focus();
}
export function publicShareUrl(token: string | null) {
  const url = new URL("/share", window.location.href);
  url.searchParams.set("share", requireValue(token, "Public link identity"));
  return url.href;
}
export function renderPublicShareFields(): void {
  const path = projectState.sharingTarget?.path;
  const publicSelected = Boolean(path && appState.element("sharing-level").value === "publicRead");
  appState.element("sharing-public-fields").hidden = !publicSelected;
  const link = path ? requireValue(projectState.sharingTarget).project.publicLinks?.[path] : null;
  appState.element("sharing-public-url").value = link ? publicShareUrl(link.token) : "";
  appState.element("sharing-reset-link").hidden = !publicSelected || !link;
  refreshSharingCopy();
}
export function refreshSharingCopy(): void {
  const copy = appState.element("sharing-copy-link");
  const publicSelected = Boolean(
    projectState.sharingTarget?.path && appState.element("sharing-level").value === "publicRead",
  );
  const path = projectState.sharingTarget?.path;
  const link = path ? projectState.sharingTarget?.project.publicLinks?.[path] : undefined;
  const unsaved =
    projectDialogState.projectView === "sharing" &&
    projectDialogState.projectFormSnapshot !== null &&
    projectDialogState.projectFormSnapshot !== projectFormState();
  copy.disabled = projectDialogState.sharingSaving || unsaved || (publicSelected && !link);
  copy.title = copy.disabled ? "Save the permissions before copying this link" : "Copy sharing link";
  setText(copy, "Copy link");
  appState.element("sharing-feedback").hidden = true;
}
