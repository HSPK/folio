import { projectModel } from "../../state/projects";
import { authenticationSession } from "../../state/authentication";
import { documentSession } from "../../state/document";
import type { DocumentSessionId } from "@folio/model";
import { readMetadataTags, updateMetadataTags } from "@folio/editor-runtime";
import { shell } from "../../state/shell";
import { element, requiredQuery, requireValue } from "../../types/elements";
import { errorContext } from "../../types/errors";
import { closeMenus } from "../accounts/authentication";
import { collaborationLocked, collaboration } from "../collaboration/collaboration";
import { appState, dirty } from "../core/bootstrap";
import { documentNotice, notice } from "../core/dom";
import { showDialog } from "../dialogs/dialogs";
import { listen } from "../lifecycle";

import { projectOwns, projectWritable } from "../projects/permissions";
import { publicState } from "../sharing/public";
import { refreshWorkspaceFavorite } from "./workspace";

let tagsDocument: DocumentSessionId | null;

export function initializeWorkspaceControls(): void {
  requiredQuery(element("sidebar-search-open"), "kbd", HTMLElement).textContent = /Mac/.test(navigator.platform)
    ? "⌘ P"
    : "Ctrl P";
  listen(element("more-actions-panel"), "toggle", (event) => {
    if (event.newState === "closed") {
      for (const menu of element("more-actions-panel").querySelectorAll<HTMLDetailsElement>(".menu-disclosure"))
        menu.open = false;
    }
  });
  listen(element("about-open"), "click", () => {
    requiredQuery(document, "#more-menu > button", HTMLElement).focus({ preventScroll: true });
    showDialog(element("about-dialog"));
  });
  listen(element("about-close"), "click", () => element("about-dialog").close());
  tagsDocument = null;
  listen(element("document-tags-open"), "click", () => {
    closeMenus();
    if (!documentSession.current || !projectWritable()) return;
    try {
      element("tags-input").value = readMetadataTags(appState.editor.value).join("\n");
      tagsDocument = documentSession.id;
      notice(element("tags-error"), "");
      showDialog(element("tags-dialog"));
      element("tags-input").focus();
    } catch (errorCause) {
      const error = errorContext(errorCause);
      documentNotice(error.message, "error");
    }
  });
  listen(element("tags-cancel"), "click", () => element("tags-dialog").close());
  listen(element("tags-form"), "submit", async (event) => {
    event.preventDefault();
    if (tagsDocument !== documentSession.id || !projectWritable()) {
      notice(element("tags-error"), "Document changed", "error");
      return;
    }
    try {
      const values = element("tags-input")
        .value.split(/\r?\n/)
        .map((tag) => tag.trim())
        .filter(Boolean);
      appState.editor.value = updateMetadataTags(appState.editor.value, values);
      appState.editor.dispatchEvent(new Event("input"));
      if (shell.view === "rich") {
        if (!(await appState.inlineEditor.replaceSource(appState.editor.value)))
          await appState.inlineEditor.load(appState.editor.value, requireValue(documentSession.current).path);
      }
      element("tags-dialog").close();
      documentNotice("");
    } catch (errorCause) {
      const error = errorContext(errorCause);
      notice(element("tags-error"), error.message, "error");
    }
  });
}
export function refreshWorkspaceControls(): void {
  const users = authenticationSession.mode === "users";
  element("more-recovery").hidden = publicState.publicView;
  element("more-workspace-actions").hidden = publicState.publicView;
  element("document-tags-open").hidden = publicState.publicView && !projectWritable();
  element("focus-mode").hidden = publicState.publicView;
  element("workspace-search-open").hidden = !users;
  element("workspace-open").hidden = !users;
  element("sidebar-search-open").hidden = !users || publicState.publicView;
  element("shares-open").hidden = !users;
  element("backlinks-open").hidden = publicState.publicView;
  element("backlinks-open").disabled = !documentSession.resourceId;
  element("attachments-open").hidden = !users || !projectModel.active?.owned;
  element("workspace-favorite").hidden = !users || !documentSession.resourceId;
  element("history-open").hidden = !users || !projectModel.active?.owned;
  element("history-open").disabled = !documentSession.resourceId;
  element("trash-open").hidden = !projectOwns();
  element("document-trash").hidden = !projectOwns();
  element("document-trash").disabled =
    !documentSession.resourceId || dirty() || Boolean(documentSession.saving || collaboration?.pending.size);
  element("document-tags-open").disabled = !documentSession.current || !projectWritable() || collaborationLocked();
  refreshWorkspaceFavorite();
}
