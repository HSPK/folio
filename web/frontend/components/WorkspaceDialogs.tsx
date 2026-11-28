import { SearchResults } from "./SearchResults";
import { DialogHeading } from "./primitives";

/** Mount account workspace, search, history, and recovery surfaces. */
export function WorkspaceDialogs() {
  return (
    <>
      <dialog id="backlinks-dialog" class="workspace-dialog" aria-labelledby="backlinks-title">
        <DialogHeading id="backlinks" title="Links to this note" />
        <div id="backlinks-list" class="workspace-list"></div>
        <p id="backlinks-message" class="notice" role="status" data-inline-status hidden></p>
      </dialog>
      <dialog id="attachments-dialog" class="workspace-dialog" aria-labelledby="attachments-title">
        <DialogHeading id="attachments" title="Attachments" />
        <label class="form-hint">
          <input id="attachments-unused" type="checkbox" checked />
          Only unreferenced files
        </label>
        <div id="attachments-list" class="workspace-list"></div>
        <p id="attachments-message" class="notice" role="status" data-inline-status hidden></p>
        <div class="dialog-actions">
          <button id="attachments-refresh" type="button">
            Refresh
          </button>
          <button id="attachments-recycle" type="button">
            Recycle selected files
          </button>
        </div>
      </dialog>
      <dialog id="public-password-dialog" aria-labelledby="public-password-title">
        <form id="public-password-form">
          <h2 id="public-password-title">Protected document</h2>
          <label for="public-password">Share password</label>
          <input id="public-password" type="password" autocomplete="off" required />
          <p id="public-password-error" class="notice is-error" role="alert" hidden></p>
          <div class="dialog-actions">
            <button id="public-password-cancel" type="button">
              Cancel
            </button>
            <button id="public-password-submit" class="button-primary" type="submit">
              Open document
            </button>
          </div>
        </form>
      </dialog>
      <dialog id="shares-dialog" class="workspace-dialog" aria-labelledby="shares-title">
        <DialogHeading id="shares" title="Your public links" />
        <div id="shares-list" class="workspace-list"></div>
        <p id="shares-message" class="notice" role="status" data-inline-status hidden></p>
      </dialog>
      <dialog id="workspace-dialog" class="workspace-dialog" aria-labelledby="workspace-title">
        <DialogHeading id="workspace" title="Your workspace" />
        <div class="workspace-filters">
          <select id="workspace-kind" aria-label="Workspace list">
            <option value="favorites">Favorites</option>
            <option value="recent">Recently opened</option>
          </select>
          <input id="workspace-filter" type="search" placeholder="Filter notes" aria-label="Filter workspace notes" />
        </div>
        <div id="workspace-list" class="workspace-list"></div>
        <p id="workspace-message" class="notice" role="status" data-inline-status hidden></p>
      </dialog>
      <dialog id="drafts-dialog" class="workspace-dialog" aria-labelledby="drafts-title">
        <DialogHeading id="drafts" title="Local recovery" />
        <div id="drafts-list" class="workspace-list"></div>
        <p id="drafts-message" class="notice" role="status" data-inline-status hidden></p>
      </dialog>
      <dialog id="draft-recovery-dialog" class="workspace-dialog" aria-labelledby="draft-recovery-title">
        <h2 id="draft-recovery-title">Recover local draft</h2>
        <p id="draft-recovery-info" class="form-hint"></p>
        <textarea
          id="draft-recovery-source"
          class="recovery-source"
          rows="14"
          readOnly
          aria-label="Recovered draft preview"
        ></textarea>
        <p id="draft-recovery-error" class="notice" role="alert" hidden></p>
        <div class="dialog-actions">
          <button id="draft-recovery-close" type="button">
            Keep stored
          </button>
          <button id="draft-recovery-discard" type="button">
            Discard copy
          </button>
          <button id="draft-recovery-copy" type="button">
            Copy draft
          </button>
          <button id="draft-recovery-apply" class="button-primary" type="button">
            Apply draft
          </button>
        </div>
      </dialog>
      <dialog id="search-dialog" class="workspace-dialog search-dialog" aria-labelledby="search-title">
        <DialogHeading id="search" title="Search notes" />
        <form id="search-form">
          <label class="visually-hidden" for="search-query">
            Search title, body and metadata
          </label>
          <input id="search-query" type="search" autocomplete="off" placeholder="Search title, body and metadata" />
          <p id="search-message" class="notice search-status" role="status" data-inline-status hidden></p>
          <details id="search-filters" class="search-filters">
            <summary>
              <span id="search-filter-label">Filters</span>
              <svg data-icon="chevron-down" aria-hidden="true"></svg>
            </summary>
            <div class="workspace-filters">
              <div class="workspace-filter">
                <label for="search-project">Project</label>
                <select id="search-project"></select>
              </div>
              <div class="workspace-filter">
                <label for="search-field">Search in</label>
                <select id="search-field">
                  <option value="all">Everything</option>
                  <option value="title">Title</option>
                  <option value="body">Body</option>
                  <option value="metadata">Metadata</option>
                </select>
              </div>
            </div>
            <div id="search-tag-filters">
              <span class="search-tags-label">Tags</span>
              <div id="search-tags" class="workspace-tags"></div>
            </div>
          </details>
          <div id="search-selected-tags" class="workspace-tags" aria-label="Selected tags"></div>
        </form>
        <div class="search-layout">
          <section>
            <SearchResults />
            <p id="search-empty" class="form-hint" hidden>
              No matching notes
            </p>
          </section>
        </div>
      </dialog>
      <dialog id="tags-dialog" aria-labelledby="tags-title">
        <form id="tags-form">
          <h2 id="tags-title">Document tags</h2>
          <label for="tags-input">Tags</label>
          <textarea
            id="tags-input"
            rows="6"
            autocomplete="off"
            placeholder="notes&#10;research"
          ></textarea>
          <p id="tags-error" class="notice is-error" role="alert" hidden></p>
          <div class="dialog-actions">
            <button id="tags-cancel" type="button">
              Cancel
            </button>
            <button class="button-primary" type="submit">
              Save tags
            </button>
          </div>
        </form>
      </dialog>
      <dialog id="history-dialog" class="workspace-dialog" aria-labelledby="history-title">
        <DialogHeading id="history" title="History" />
        <div class="history-layout">
          <nav id="history-list" aria-label="Document versions"></nav>
          <section>
            <p id="history-detail" class="form-hint"></p>
            <pre id="history-diff" class="history-diff"></pre>
          </section>
        </div>
        <p id="history-message" class="notice" role="status" data-inline-status hidden></p>
        <div class="dialog-actions">
          <button id="history-copy" type="button" disabled>
            Copy version
          </button>
          <button id="history-restore" class="button-primary" type="button" disabled>
            Restore version
          </button>
        </div>
      </dialog>
      <dialog id="trash-dialog" class="workspace-dialog" aria-labelledby="trash-title">
        <DialogHeading id="trash" title="Recycle bin" />
        <div id="trash-list" class="workspace-list"></div>
        <p id="trash-message" class="notice" role="status" data-inline-status hidden></p>
      </dialog>
    </>
  );
}
