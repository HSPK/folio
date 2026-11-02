import { AppDialog } from "./primitives";

/** Provide persistent command, account, about, and confirmation surfaces. */
export function ApplicationDialogs() {
  return (
    <>
      <AppDialog id="command-dialog" class="command-dialog" aria-labelledby="command-title">
        <form id="command-form">
          <div class="command-search">
            <svg data-icon="search" aria-hidden="true"></svg>
            <label id="command-title" class="visually-hidden" for="command-query">
              Commands
            </label>
            <input
              id="command-query"
              type="search"
              placeholder="Search commands"
              autocomplete="off"
              spellcheck="false"
            />
            <button id="command-close" type="button" aria-label="Close command panel">
              Esc
            </button>
          </div>
          <div id="command-list" class="command-list" role="listbox" aria-label="Commands"></div>
          <p id="command-empty" class="command-empty" hidden>
            No matching commands
          </p>
        </form>
      </AppDialog>
      <AppDialog id="about-dialog" class="about-dialog" aria-labelledby="about-title">
        <h2 id="about-title">Folio</h2>
        <p>A local-first Markdown workspace for writing, organizing notes, and collaborating.</p>
        <p>
          <a href="/THIRD-PARTY-LICENSES.txt" target="_blank" rel="noopener noreferrer">
            Third-party licenses
          </a>
        </p>
        <div class="dialog-actions">
          <button id="about-close" type="button">
            Close
          </button>
        </div>
      </AppDialog>
      <AppDialog id="account-password-dialog" aria-labelledby="account-password-title">
        <form id="account-password-form">
          <h2 id="account-password-title">Reset password</h2>
          <label for="account-password">New password</label>
          <input id="account-password" type="password" autocomplete="new-password" required />
          <p id="account-password-error" class="notice is-error" role="alert" hidden></p>
          <div class="dialog-actions">
            <button id="account-password-cancel" type="button">
              Cancel
            </button>
            <button class="button-primary" type="submit">
              Reset password
            </button>
          </div>
        </form>
      </AppDialog>
      <AppDialog id="confirmation-dialog" class="confirmation-dialog" aria-labelledby="confirmation-title">
        <h2 id="confirmation-title">Confirm action</h2>
      </AppDialog>
    </>
  );
}
