import { projectModel } from "../../state/projects";
import { authenticationSession } from "../../state/authentication";
import { documentSession } from "../../state/document";
import { createDocumentModel, serializeEditorText, type DocumentModel } from "@folio/model";
import { primaryShortcut } from "../../../shared/keyboard";
import { decodedDocument } from "../../api/contracts";
import { readMetadataTags, updateMetadataTags } from "@folio/editor-runtime";
import { shell } from "../../state/shell";
import { element, requiredQuery, requireValue } from "../../types/elements";
import { errorContext } from "../../types/errors";
import { closeMenus } from "../accounts/authentication";
import { collaborationLocked, collaboration } from "../collaboration/collaboration";
import { appState, dirty } from "../core/bootstrap";
import { documentNotice, notice } from "../core/dom";
import { api } from "../core/api";
import { confirmAction, showDialog } from "../dialogs/dialogs";
import { listen } from "../lifecycle";

import { projectOwns, projectWritable } from "../projects/permissions";
import { publicState } from "../sharing/public";
import { refreshWorkspaceFavorite } from "./workspace";
import { refreshFiles } from "../navigation/library";

let tagsDocument: {
  document: DocumentModel;
  session: symbol;
  selection: symbol;
  input: string;
  submitted: string | null;
} | null;
let tagsGeneration = 0;
const tagsSave = () => requiredQuery(element("tags-form"), 'button[type="submit"]', HTMLButtonElement);

export async function openDocumentTags(id = documentSession.current?.id) {
  if (!id) return;
  closeMenus();
  const generation = ++tagsGeneration,
    session = documentSession.id,
    selection = projectModel.selection;
  const signal = authenticationSession.scope.signal;
  const current = () =>
    generation === tagsGeneration &&
    !signal.aborted &&
    session === documentSession.id &&
    selection === projectModel.selection &&
    element("tags-dialog").open;
  tagsDocument = null;
  element("tags-input").value = "";
  element("tags-input").disabled = tagsSave().disabled = true;
  tagsSave().textContent = "Save tags";
  element("tags-form").setAttribute("aria-busy", "true");
  notice(element("tags-error"), "");
  element("tags-title").textContent = "Loading tags…";
  showDialog(element("tags-dialog"));
  try {
    const active = documentSession.current?.id === id;
    const payload = active
      ? requireValue(documentSession.current)
      : await api(`/api/document?id=${encodeURIComponent(id)}&render=source`, { decode: decodedDocument, signal });
    if (!current()) return;
    if (!projectWritable(payload.path) || (active && collaborationLocked()) || payload.permissions?.writable === false)
      throw new Error("This note is read only.");
    const model = createDocumentModel(payload);
    const input = readMetadataTags(active ? appState.editor.value : model.text).join("\n");
    tagsDocument = { document: model, session, selection, input, submitted: null };
    element("tags-title").textContent = `Tags · ${model.title || model.path}`;
    element("tags-input").value = input;
    element("tags-input").disabled = tagsSave().disabled = false;
    element("tags-form").setAttribute("aria-busy", "false");
    element("tags-input").focus();
  } catch (cause) {
    if (current()) {
      element("tags-title").textContent = "Document tags";
      element("tags-form").setAttribute("aria-busy", "false");
      notice(element("tags-error"), errorContext(cause).message, "error");
    }
  }
}

export function initializeWorkspaceControls(): void {
  requiredQuery(element("sidebar-search-open"), "kbd", HTMLElement).textContent = primaryShortcut("P");
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
  tagsGeneration = 0;
  listen(element("document-tags-open"), "click", () => void openDocumentTags());
  listen(element("tags-cancel"), "click", () => element("tags-dialog").close());
  listen(element("tags-dialog"), "close", () => {
    if (!element("tags-dialog").open) {
      tagsDocument = null;
      tagsGeneration++;
    }
  });
  listen(element("tags-dialog"), "cancel", (event) => {
    const target = tagsDocument;
    if (!target || element("tags-input").value === (target.submitted ?? target.input)) return;
    event.preventDefault();
    void confirmAction("Discard your unsaved tags?", {
      label: "Discard changes",
      tone: "destructive",
      signal: authenticationSession.scope.signal,
    }).then((accepted) => {
      if (accepted && tagsDocument === target) element("tags-dialog").close();
    });
  });
  listen(element("tags-form"), "submit", async (event) => {
    event.preventDefault();
    const target = tagsDocument;
    if (!target || tagsSave().disabled) return;
    if (
      target.session !== documentSession.id ||
      target.selection !== projectModel.selection ||
      !projectWritable(target.document.path)
    ) {
      notice(element("tags-error"), "Document changed", "error");
      return;
    }
    const input = element("tags-input").value;
    const owner = authenticationSession.scope;
    target.submitted = input;
    tagsSave().disabled = true;
    tagsSave().textContent = "Saving…";
    element("tags-form").setAttribute("aria-busy", "true");
    try {
      const values = input
        .split(/\r?\n/)
        .map((tag) => tag.trim())
        .filter(Boolean);
      if (target.document.id === documentSession.current?.id) {
        if (collaborationLocked()) throw new Error("This note is read only.");
        appState.editor.value = updateMetadataTags(appState.editor.value, values);
        appState.editor.dispatchEvent(new Event("input"));
        if (shell.view === "rich") {
          if (!(await appState.inlineEditor.replaceSource(appState.editor.value)))
            await appState.inlineEditor.load(appState.editor.value, requireValue(documentSession.current).path);
        }
      } else {
        const content = serializeEditorText(target.document, updateMetadataTags(target.document.text, values));
        target.document = createDocumentModel(
          await api("/api/document", {
            decode: decodedDocument,
            method: "PUT",
            signal: owner.signal,
            body: { id: target.document.id, version: target.document.version, content },
          }),
        );
        if (target.selection === projectModel.selection) void refreshFiles();
      }
      target.input = input;
      if (tagsDocument === target && element("tags-dialog").open) {
        if (element("tags-input").value === input) element("tags-dialog").close();
        else notice(element("tags-error"), "Saved; newer edits unsaved", "warning");
      }
    } catch (errorCause) {
      if (!owner.signal.aborted && target.selection === projectModel.selection) {
        const message = errorContext(errorCause).message;
        if (tagsDocument === target) notice(element("tags-error"), message, "error");
        else documentNotice(`Tags not saved for ${target.document.title || target.document.path}: ${message}`, "error");
      }
    } finally {
      target.submitted = null;
      if (tagsDocument === target) tagsSave().disabled = false;
      if (!tagsDocument || tagsDocument === target) {
        tagsSave().textContent = "Save tags";
        element("tags-form").setAttribute("aria-busy", "false");
      }
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
