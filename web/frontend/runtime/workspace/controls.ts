import { projectModel } from "../../state/projects";
import { authenticationSession } from "../../state/authentication";
import { documentSession } from "../../state/document";
import type { DocumentSessionId } from "@folio/model";
import { createIcon, hydrateIcons, readMetadataTags, updateMetadataTags } from "@folio/editor-runtime";
import { shell } from "../../state/shell";
import { requiredQuery, requireValue } from "../../types/elements";
import { errorContext } from "../../types/errors";
import { closeMenus } from "../accounts/authentication";
import { collaborationLocked, collaborationState } from "../collaboration/collaboration";
import { appState, dirty } from "../core/bootstrap";
import { documentNotice, notice } from "../core/dom";
import { setPageWidth } from "../core/layout";
import { showDialog } from "../dialogs/dialogs";
import { listen } from "../lifecycle";

import { projectWritable } from "../projects/permissions";
import { publicState } from "../sharing/public";
import { refreshWorkspaceFavorite } from "./workspace";

class WorkspaceControlState {
  tagsDocument!: DocumentSessionId | null;
}
export const workspaceControlState = new WorkspaceControlState();
export function initializeWorkspaceControls(): void {
  setPageWidth(document.documentElement.dataset.pageWidth);
  hydrateIcons(appState.element("compact-layout-menu"));
  for (const button of document.querySelectorAll<HTMLButtonElement>(".workspace-heading > button")) {
    button.classList.add("icon-button");
    button.setAttribute(
      "aria-label",
      `Close ${requireValue(requiredQuery(requireValue(button.parentElement), "h2", HTMLElement).textContent).toLowerCase()}`,
    );
    button.title = "Close";
    button.replaceChildren(createIcon("x"));
  }
  requiredQuery(appState.element("sidebar-search-open"), "kbd", HTMLElement).textContent = /Mac/.test(
    navigator.platform,
  )
    ? "⌘ P"
    : "Ctrl P";
  listen(appState.element("more-menu"), "toggle", () => {
    if (!appState.element("more-menu").open) {
      for (const menu of appState.element("more-menu").querySelectorAll<HTMLDetailsElement>(".menu-disclosure"))
        menu.open = false;
    }
  });
  listen(appState.element("about-open"), "click", () => {
    requiredQuery(document, "#more-menu > summary", HTMLElement).focus({ preventScroll: true });
    showDialog(appState.element("about-dialog"));
  });
  listen(appState.element("about-close"), "click", () => appState.element("about-dialog").close());
  workspaceControlState.tagsDocument = null;
  listen(appState.element("document-tags-open"), "click", () => {
    closeMenus();
    if (!documentSession.current || !projectWritable()) return;
    try {
      appState.element("tags-input").value = readMetadataTags(appState.ui.editor.value).join("\n");
      workspaceControlState.tagsDocument = documentSession.id;
      notice(appState.element("tags-error"), "");
      showDialog(appState.element("tags-dialog"));
      appState.element("tags-input").focus();
    } catch (errorCause) {
      const error = errorContext(errorCause);
      documentNotice(error.message, "error");
    }
  });
  listen(appState.element("tags-cancel"), "click", () => appState.element("tags-dialog").close());
  listen(appState.element("tags-form"), "submit", async (event) => {
    event.preventDefault();
    if (workspaceControlState.tagsDocument !== documentSession.id || !projectWritable()) {
      notice(appState.element("tags-error"), "The open document or its permissions changed.", "error");
      return;
    }
    try {
      const values = appState
        .element("tags-input")
        .value.split(/\r?\n/)
        .map((tag) => tag.trim())
        .filter(Boolean);
      appState.ui.editor.value = updateMetadataTags(appState.ui.editor.value, values);
      appState.ui.editor.dispatchEvent(new Event("input"));
      if (shell.view === "rich") {
        if (!(await appState.inlineEditor.replaceSource(appState.ui.editor.value)))
          await appState.inlineEditor.load(appState.ui.editor.value, requireValue(documentSession.current).path);
      }
      appState.element("tags-dialog").close();
      documentNotice("");
    } catch (errorCause) {
      const error = errorContext(errorCause);
      notice(appState.element("tags-error"), error.message, "error");
    }
  });
}
export function refreshWorkspaceControls(): void {
  const users = authenticationSession.mode === "users";
  appState.element("workspace-search-open").hidden = !users;
  appState.element("workspace-open").hidden = !users;
  appState.element("library-shortcuts").hidden = !users || publicState.publicView;
  appState.element("sidebar-search-open").hidden = !users || publicState.publicView;
  appState.element("shares-open").hidden = !users;
  appState.element("backlinks-open").hidden = publicState.publicView;
  appState.element("backlinks-open").disabled = !documentSession.current;
  appState.element("attachments-open").hidden = !users || !projectModel.active?.owned;
  appState.element("workspace-favorite").hidden = !users || !documentSession.current;
  appState.element("history-open").hidden = !users || !projectModel.active?.owned;
  appState.element("history-open").disabled = !documentSession.current;
  appState.element("trash-open").hidden = !users || !projectModel.active?.owned;
  appState.element("document-trash").hidden = !users || !projectModel.active?.owned;
  appState.element("document-trash").disabled =
    !documentSession.current ||
    dirty() ||
    Boolean(documentSession.saving || collaborationState.collaboration?.pending.size);
  appState.element("document-tags-open").disabled =
    !documentSession.current || !projectWritable() || collaborationLocked();
  refreshWorkspaceFavorite();
}
