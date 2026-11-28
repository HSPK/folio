import { projectViewState as projectState } from "../projects/view-state";
import { resetButtonFeedback } from "../../../shared/feedback";
import { projectModel } from "../../state/projects";
import { libraryModel } from "../../state/library";
import { authenticationSession } from "../../state/authentication";
import { documentSession } from "../../state/document";
import { decodedPublicSession } from "../../api/contracts";
import { isPublicPage, isResourceId, isShareId, makeNoteUrl, shareIdFromUrl, shortShareId } from "@folio/model";
import { readLayoutPreference, storeLayoutPreference } from "../core/layout";
import { element, requireValue } from "../../types/elements";
import { errorContext } from "../../types/errors";
import { connectionFailure, hideAuthentication, refreshControls, setSidebar } from "../accounts/authentication";
import { collaboration, connectCollaboration } from "../collaboration/collaboration";
import { api } from "../core/api";
import { stopAppearancePolling } from "../core/appearance";
import { clearServiceOutage, isConnectionLoss } from "../core/recovery";
import { appState } from "../core/bootstrap";
import { ApiError, notice, setText } from "../core/dom";
import { showDialog } from "../dialogs/dialogs";
import { navigateTo } from "../documents/navigation";
import { rememberResource } from "../documents/resources";
import { listen } from "../lifecycle";
import { openFilePanel } from "../navigation/panels";
import { commitUrl } from "../documents/navigation";
import { confirmProjectAction, projectDialogState, projectFormState } from "../projects/dialog";
import { saveSharing, updateProjectControls } from "../projects/projects";
class PublicState {
  publicView!: boolean;
  publicToken!: string | null;
  recoveryKey!: string | null;
  publicWritable!: boolean;
  publicApiPaths!: Set<string>;
}
export const publicState = new PublicState();
export function initializeSharingPublic(): void {
  publicState.publicView = isPublicPage(window.location.pathname);
  publicState.publicToken = shareIdFromUrl(new URL(window.location.href));
  publicState.recoveryKey = null;
  if (publicState.publicView) initializeReadingOptions();
  publicState.publicWritable = false;
  publicState.publicApiPaths = new Set([
    "session",
    "document",
    "panel-file",
    "preview",
    "images",
    "resource",
    "resources/resolve",
    "collaboration/join",
    "collaboration/presence",
  ]);
  listen(element("public-password-cancel"), "click", () => element("public-password-dialog").close());
  listen(element("public-password-form"), "submit", async (event) => {
    event.preventDefault();
    element("public-password-submit").disabled = true;
    try {
      await connectPublic(element("public-password").value);
    } finally {
      element("public-password-submit").disabled = false;
      element("public-password").value = "";
    }
  });
  listen(element("sharing-form"), "input", refreshSharingCopy);
  listen(element("sharing-form"), "change", refreshSharingCopy);
  listen(element("sharing-level"), "change", renderPublicShareFields);
  listen(element("sharing-reset-link"), "click", async () => {
    if (
      !(await confirmProjectAction("Reset this public link? Existing links stop working", {
        label: "Reset link",
        tone: "destructive",
      }))
    )
      return;
    await saveSharing(true);
  });
  listen(element("sharing-clear-password"), "change", () => {
    element("sharing-password").disabled = element("sharing-clear-password").checked;
    if (element("sharing-clear-password").checked) element("sharing-password").value = "";
  });
}
export function scopedApiPath(path: string, headers: Record<string, string>) {
  if (publicState.publicView) {
    const url = new URL(path, window.location.href);
    const name = url.pathname.replace(/^\/api\/(?:public\/)?/, "");
    if (!publicState.publicApiPaths.has(name)) throw new ApiError("Unavailable in public documents", 403);
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
  notice(element("tree-message"), "");
  notice(element("tree-limit"), "");
  setSidebar(false);
  updateProjectControls();
  appState.connectionState = "connecting";
  refreshControls();
  try {
    if (!isShareId(publicState.publicToken ?? "")) throw new ApiError("Invalid public link", 403);
    const session = await api("/api/public/session", {
      decode: decodedPublicSession,
      method: "POST",
      timeoutMs: 15000,
      ...(password !== undefined ? { body: { password } } : {}),
    });
    clearServiceOutage();
    if (session.passwordRequired) {
      publicState.publicWritable = false;
      appState.connectionState = "error";
      requestPublicPassword();
      return;
    }
    if (!isResourceId(session.id) || typeof session.path !== "string" || typeof session.writable !== "boolean") {
      throw new ApiError("Incomplete public document");
    }
    publicState.publicWritable = session.writable;
    publicState.recoveryKey = session.recoveryKey ?? publicState.publicToken;
    if (session.code) publicState.publicToken = session.code;
    element("public-password-dialog").close();
    element("public-password").value = "";
    appState.currentRoot = session.file ? "Public file" : "Public document";
    appState.connectionState = "ready";
    if (session.file) {
      rememberResource(session, session.project ?? "local", "asset");
      libraryModel.replace([], [], false, [{ path: session.path, name: session.path.split("/").at(-1)! }]);
      commitUrl(new URL(publicShareUrl(publicState.publicToken)), "replace");
      document.title = `${session.path.split("/").at(-1)} — Folio`;
      await openFilePanel(session.path);
    } else if (!documentSession.current) {
      rememberResource(session, session.project ?? "local");
      const url = makeNoteUrl(publicShareUrl(publicState.publicToken), session.id, window.location.hash);
      await navigateTo(session.id, url.hash, { url, mode: "replace" });
    } else {
      notice(element("connection-message"), "");
      if (collaboration) await connectCollaboration(collaboration);
    }
  } catch (errorCause) {
    const error = errorContext(errorCause);
    publicState.publicWritable = false;
    appState.connectionState = "error";
    if (isConnectionLoss(error)) {
      if (element("public-password-dialog").open) notice(element("public-password-error"), "Disconnected", "error");
      else connectionFailure(error);
      return;
    }
    clearServiceOutage();
    notice(element("connection-message"), error.message, "error");
    if (error.status === 401) {
      requestPublicPassword();
      notice(element("public-password-error"), error.message, "error");
    }
  } finally {
    refreshControls();
  }
}
export function requestPublicPassword(): void {
  clearServiceOutage();
  notice(element("public-password-error"), "");
  showDialog(element("public-password-dialog"));
  element("public-password").focus();
}
export function publicShareUrl(token: string | null) {
  return new URL(`/s/${shortShareId(requireValue(token, "Public link identity"))}`, window.location.href).href;
}
function initializeReadingOptions(): void {
  const theme = element("reader-theme");
  const size = element("reader-size");
  const apply = () => {
    document.documentElement.dataset.theme = theme.value;
    document.documentElement.style.setProperty("--document-size", `${size.value}px`);
    document.documentElement.style.setProperty("--source-size", `${Number(size.value) - 2}px`);
  };
  for (const [control, key] of [
    [theme, "folio.reader.theme"],
    [size, "folio.reader.size"],
  ] as const) {
    const stored = readLayoutPreference(key);
    if ([...control.options].some((option) => option.value === stored)) control.value = stored!;
    listen(control, "change", () => {
      storeLayoutPreference(key, control.value);
      apply();
    });
  }
  element("reader-options").hidden = false;
  apply();
}
export function renderPublicShareFields(): void {
  const path = projectState.sharingTarget?.path;
  const publicSelected = Boolean(path && element("sharing-level").value === "publicRead");
  element("sharing-public-fields").hidden = !publicSelected;
  const link = path ? requireValue(projectState.sharingTarget).project.publicLinks?.[path] : null;
  element("sharing-public-url").value = link ? publicShareUrl(link.token) : "";
  element("sharing-reset-link").hidden = !publicSelected || !link;
  refreshSharingCopy();
}
export function refreshSharingCopy(): void {
  const copy = element("sharing-copy-link");
  resetButtonFeedback(copy);
  const publicSelected = Boolean(projectState.sharingTarget?.path && element("sharing-level").value === "publicRead");
  const path = projectState.sharingTarget?.path;
  const link = path ? projectState.sharingTarget?.project.publicLinks?.[path] : undefined;
  const unsaved =
    projectDialogState.projectView === "sharing" &&
    projectDialogState.projectFormSnapshot !== null &&
    projectDialogState.projectFormSnapshot !== projectFormState();
  copy.disabled = projectDialogState.sharingSaving || unsaved || (publicSelected && !link);
  copy.title = copy.disabled ? "Save permissions to copy the link" : "Copy link";
  setText(copy, "Copy link");
  element("sharing-feedback").hidden = true;
}
