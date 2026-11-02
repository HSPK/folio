import { AppDialog } from "./primitives";

/** Keep file-operation forms and their controller references stable between openings. */
export function FileDialogs() {
  return (
    <>
      <AppDialog id="new-note-dialog" aria-labelledby="new-note-heading">
        <form id="new-note-form">
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
            <button id="cancel-new-note" type="button">
              Cancel
            </button>
            <button id="create-note" class="button-primary" type="submit">
              Create note
            </button>
          </div>
        </form>
      </AppDialog>
      <AppDialog id="new-folder-dialog" aria-labelledby="new-folder-title">
        <form id="new-folder-form">
          <h2 id="new-folder-title">New folder</h2>
          <label for="new-folder-path">Folder path</label>
          <input
            id="new-folder-path"
            name="path"
            type="text"
            placeholder="New folder"
            autocomplete="off"
            spellcheck="false"
            aria-describedby="new-folder-error"
            required
          />
          <p id="new-folder-error" class="notice is-error" role="alert" hidden></p>
          <div class="dialog-actions">
            <button id="cancel-new-folder" type="button">
              Cancel
            </button>
            <button id="create-folder" class="button-primary" type="submit">
              Create folder
            </button>
          </div>
        </form>
      </AppDialog>
      <div id="file-context-menu" class="context-menu" role="menu" aria-label="File actions" hidden>
        <span id="file-context-name" class="menu-context-label"></span>
        <button id="file-details" type="button" role="menuitem">
          Details
        </button>
        <button id="file-rename" type="button" role="menuitem">
          Rename
        </button>
      </div>
      <AppDialog id="rename-dialog" aria-labelledby="rename-title">
        <form id="rename-form">
          <h2 id="rename-title">Rename</h2>
          <label for="rename-path">Name</label>
          <input id="rename-path" name="path" type="text" autocomplete="off" spellcheck="false" required />
          <p id="rename-hint" class="form-hint"></p>
          <p id="rename-error" class="notice is-error" role="alert" hidden></p>
          <label class="form-hint">
            <input id="rename-update-links" type="checkbox" checked />
            Update Markdown and wiki references
          </label>
          <div class="dialog-actions">
            <button id="cancel-rename" type="button">
              Cancel
            </button>
            <button id="confirm-rename" class="button-primary" type="submit">
              Rename
            </button>
          </div>
        </form>
      </AppDialog>
      <AppDialog id="details-dialog" aria-labelledby="details-title">
        <h2 id="details-title">File details</h2>
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
        <div class="dialog-actions">
          <button id="close-details" type="button">
            Close
          </button>
        </div>
      </AppDialog>
    </>
  );
}
