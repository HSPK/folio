import { AppDialog } from "./primitives";

/** Keep project browsing, creation, and sharing in one focused surface. */
export function ProjectDialog() {
  return (
    <>
      <AppDialog id="projects-dialog" class="projects-dialog" aria-labelledby="projects-title" data-view="browse">
        <header class="projects-heading">
          <div class="project-heading-title">
            <button
              id="project-back"
              class="icon-button"
              type="button"
              aria-label="Back to projects"
              title="Back"
              hidden
            >
              <svg data-icon="arrow-left" aria-hidden="true"></svg>
            </button>
            <h2 id="projects-title">Projects</h2>
          </div>
          <div class="project-header-actions">
            <button id="projects-close" class="icon-button" type="button" aria-label="Close projects">
              <svg data-icon="x" aria-hidden="true"></svg>
            </button>
          </div>
        </header>
        <section id="project-confirm" class="project-confirm" role="alert" data-confirmation-region hidden>
          <p id="project-confirm-message" data-confirmation-message></p>
          <div class="dialog-actions">
            <button id="project-confirm-cancel" data-confirmation-cancel type="button">
              Cancel
            </button>
            <button id="project-confirm-proceed" data-confirmation-proceed class="button-primary" type="button">
              Continue
            </button>
          </div>
        </section>
        <section id="projects-browser" data-project-view="browse">
          <div class="search-field project-search">
            <svg data-icon="search" aria-hidden="true"></svg>
            <label for="projects-filter" class="visually-hidden">
              Search projects
            </label>
            <input id="projects-filter" type="search" placeholder="Search projects" autocomplete="off" />
          </div>
          <div id="projects-list" class="projects-list" role="list" aria-label="Projects"></div>
          <p id="projects-empty" class="project-empty" role="status" hidden>
            No projects
          </p>
          <div class="project-picker-footer">
            <button id="project-new" class="project-new-action" type="button">
              <svg data-icon="plus" aria-hidden="true"></svg>
              <span>New project</span>
            </button>
          </div>
        </section>
        <form id="project-create-form" data-project-view="create" hidden>
          <div class="project-field">
            <label for="project-name">Name</label>
            <input id="project-name" maxLength="200" required autocomplete="off" />
          </div>
          <div class="project-field">
            <label for="project-kind">Source</label>
            <select id="project-kind">
              <option value="new">Private folder</option>
              <option value="folder" data-admin-only>
                Existing folder
              </option>
            </select>
          </div>
          <div id="project-source-field" class="project-field" hidden>
            <label for="project-source">Folder path</label>
            <input id="project-source" autocomplete="off" spellcheck="false" placeholder="/path/to/notes" />
          </div>
          <div class="dialog-actions">
            <button id="project-create-cancel" type="button">
              Cancel
            </button>
            <button id="project-create" class="button-primary" type="submit">
              Create project
            </button>
          </div>
        </form>
        <section id="sharing-dialog" data-project-view="sharing" hidden>
          <form id="sharing-form">
            <h2 id="sharing-title" class="visually-hidden">
              Sharing
            </h2>
            <p id="sharing-description" class="form-hint"></p>
            <div id="sharing-project-fields">
              <div class="project-field">
                <label for="sharing-name">Name</label>
                <input id="sharing-name" maxLength="200" required />
              </div>
              <div class="project-field">
                <label for="sharing-root">Folder path</label>
                <input id="sharing-root" required autocomplete="off" spellcheck="false" />
              </div>
              <div class="project-field">
                <label for="sharing-image-directory">Image folder</label>
                <input id="sharing-image-directory" required maxLength="512" placeholder="assets/images" />
              </div>
            </div>
            <div class="project-field">
              <label for="sharing-level">Access</label>
              <select id="sharing-level">
                <option value="private">No separate sharing</option>
                <option value="read">Can read</option>
                <option value="edit">Can edit together</option>
              </select>
            </div>
            <div id="sharing-public-fields" hidden>
              <label>
                <input id="sharing-public-edit" type="checkbox" />
                Allow anonymous editing
              </label>
              <div class="project-field">
                <label for="sharing-public-url">Public link</label>
                <input id="sharing-public-url" type="text" readOnly placeholder="Save to create a link" />
              </div>
              <button id="sharing-reset-link" class="project-text-action" type="button" hidden>
                Reset public link
              </button>
              <div class="project-field">
                <label for="sharing-expires">Expires</label>
                <input id="sharing-expires" type="datetime-local" />
              </div>
              <div class="project-field">
                <label for="sharing-password">Password</label>
                <input id="sharing-password" type="password" autocomplete="new-password" />
              </div>
              <label id="sharing-clear-password-field" hidden>
                <input id="sharing-clear-password" type="checkbox" />
                Remove password protection
              </label>
            </div>
            <section id="sharing-documents-section" class="project-permissions" hidden>
              <h3>Page permissions</h3>
              <div
                id="sharing-documents"
                class="projects-list"
                aria-label="Documents with independent permissions"
              ></div>
            </section>
            <p id="sharing-error" class="notice is-error dialog-status" role="alert" data-inline-status hidden></p>
            <p id="sharing-feedback" class="visually-hidden" role="status" hidden></p>
            <div class="dialog-actions">
              <button id="sharing-copy-link" type="button">
                Copy link
              </button>
              <button id="sharing-cancel" type="button">
                Cancel
              </button>
              <button id="sharing-save" class="button-primary" type="submit">
                Save
              </button>
            </div>
          </form>
        </section>
        <p id="project-error" class="notice is-error dialog-status" role="alert" hidden></p>
      </AppDialog>
    </>
  );
}
