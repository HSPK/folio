import { appState } from "../runtime/core/bootstrap";
import {
  addParent,
  closeFileContextMenu,
  createNote,
  refreshNewNoteHint,
  showFileDetails,
  startTreeRename,
} from "../runtime/navigation/files";
import { createTreeEntry, duplicateTreeFile } from "../runtime/navigation/creation";
import { element } from "../types/elements";
import { navigateMenu } from "./primitives";

/** Keep file-operation forms and their controller references stable between openings. */
export function FileDialogs() {
  return (
    <>
      <dialog
        id="new-note-dialog"
        aria-labelledby="new-note-heading"
        onCancel={(event) => {
          if (appState.creating) event.preventDefault();
        }}
      >
        <form id="new-note-form" onSubmit={createNote}>
          <h2 id="new-note-heading">New note</h2>
          <label for="new-note-title">Title</label>
          <input
            id="new-note-title"
            name="title"
            type="text"
            placeholder="Untitled"
            autocomplete="off"
            aria-describedby="new-note-hint new-note-error"
            required
            onInput={(event) => {
              event.currentTarget.setAttribute("aria-invalid", "false");
              refreshNewNoteHint();
            }}
          />
          <p id="new-note-hint" class="form-hint"></p>
          <p id="new-note-error" class="notice is-error" role="alert" hidden></p>
          <label for="new-note-template">Template</label>
          <select id="new-note-template">
            <option value="blank">Blank note</option>
            <option value="daily">Daily journal</option>
            <option value="weekly">Weekly review</option>
            <option value="meeting">Meeting notes</option>
          </select>
          <div class="dialog-actions">
            <button
              id="cancel-new-note"
              type="button"
              onClick={() => {
                if (!appState.creating) element("new-note-dialog").close();
              }}
            >
              Cancel
            </button>
            <button id="create-note" class="button-primary" type="submit">
              Create note
            </button>
          </div>
        </form>
      </dialog>
      <div
        id="file-context-menu"
        class="context-menu"
        role="menu"
        aria-label="File actions"
        hidden
        onKeyDown={(event) => {
          navigateMenu(event, event.currentTarget);
          if (event.key === "Escape" || event.key === "Tab") {
            if (event.key === "Escape") event.preventDefault();
            closeFileContextMenu();
          }
          event.stopPropagation();
        }}
      >
        <button
          id="tree-new-note"
          type="button"
          role="menuitem"
          data-menu-icon="file-plus"
          hidden
          onClick={() => {
            if (addParent !== null) createTreeEntry("file", addParent);
          }}
        >
          New note
        </button>
        <button
          id="tree-new-folder"
          type="button"
          role="menuitem"
          data-menu-icon="folder-plus"
          hidden
          onClick={() => {
            if (addParent !== null) createTreeEntry("directory", addParent);
          }}
        >
          New folder
        </button>
        <button
          id="file-details"
          type="button"
          role="menuitem"
          data-menu-icon="circle-help"
          onClick={() => showFileDetails()}
        >
          Properties
        </button>
        <button id="file-rename" type="button" role="menuitem" data-menu-icon="edit" onClick={() => startTreeRename()}>
          Rename
        </button>
        <small id="file-rename-hint" class="action-hint" hidden>
          End collaborative editing before renaming.
        </small>
        <button
          id="file-duplicate"
          type="button"
          role="menuitem"
          data-menu-icon="copy"
          onClick={() => {
            const entry = appState.contextFile;
            if (entry?.kind === "file") duplicateTreeFile(entry.path);
          }}
        >
          Duplicate
        </button>
        <button id="file-recycle" type="button" role="menuitem" data-menu-icon="trash">
          Recycle
        </button>
        <button type="button" role="menuitem" data-file-action="copy-path" data-menu-icon="link">
          Copy path
        </button>
        <button type="button" role="menuitem" data-file-action="download" data-menu-icon="download">
          Download
        </button>
        <button type="button" role="menuitem" data-file-action="share" data-menu-icon="users">
          Share file
        </button>
        <button type="button" role="menuitem" data-file-action="copy-link" data-menu-icon="link">
          Copy link
        </button>
        <button type="button" role="menuitem" data-file-action="favorite" data-menu-icon="star">
          Favorite
        </button>
        <button type="button" role="menuitem" data-file-action="tags" data-menu-icon="tag">
          Edit tags
        </button>
        <button type="button" role="menuitem" data-note-action="copy-text" data-menu-icon="copy">
          Copy Markdown
        </button>
        <button type="button" role="menuitem" data-note-action="workspace-favorite" data-menu-icon="star">
          Favorite
        </button>
        <button type="button" role="menuitem" data-note-action="document-tags-open" data-menu-icon="tag">
          Edit tags
        </button>
        <button type="button" role="menuitem" data-note-action="share-page" data-menu-icon="link">
          Share page
        </button>
        <button type="button" role="menuitem" data-note-action="backlinks-open" data-menu-icon="arrow-left-right">
          Backlinks
        </button>
        <button type="button" role="menuitem" data-note-action="attachments-open" data-menu-icon="paperclip">
          Attachments
        </button>
        <button type="button" role="menuitem" data-note-action="history-open" data-menu-icon="clock">
          History
        </button>
        <button type="button" role="menuitem" data-file-action="reload" data-menu-icon="refresh">
          Reload
        </button>
      </div>
      <div id="entry-icon-popup" class="context-menu" popover="auto" role="dialog" aria-label="Choose icon">
        <div id="file-icon-choices" class="context-icons" role="group" aria-label="Icon"></div>
      </div>
      <dialog id="details-dialog" aria-labelledby="details-title">
        <h2 id="details-title">Properties</h2>
        <dl class="file-details">
          <div>
            <dt>Name</dt>
            <dd id="details-name"></dd>
          </div>
          <div>
            <dt>Title</dt>
            <dd id="details-metadata-title"></dd>
          </div>
          <div>
            <dt>Path</dt>
            <dd id="details-path"></dd>
          </div>
          <div>
            <dt>Size</dt>
            <dd id="details-size"></dd>
          </div>
          <div>
            <dt>Modified</dt>
            <dd id="details-modified"></dd>
          </div>
        </dl>
        <form id="file-properties-form" hidden>
          <label for="file-property-title">Title</label>
          <input id="file-property-title" maxlength={512} autocomplete="off" />
          <label for="file-property-tags">Tags</label>
          <input id="file-property-tags" placeholder="Comma-separated tags" autocomplete="off" />
          <label for="file-property-description">Description</label>
          <textarea id="file-property-description" rows={3} maxlength={8192}></textarea>
          <p id="file-properties-error" class="notice is-error" role="alert" hidden></p>
        </form>
        <div class="dialog-actions">
          <button id="close-details" type="button" onClick={() => element("details-dialog").close()}>
            Close
          </button>
          <button id="file-properties-save" type="submit" form="file-properties-form" class="button-primary" hidden>
            Save
          </button>
        </div>
      </dialog>
    </>
  );
}
