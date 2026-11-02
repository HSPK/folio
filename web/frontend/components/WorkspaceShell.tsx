import { shell } from "../state/shell";
import { DocumentWorkspace } from "./DocumentWorkspace";
import { LibrarySidebar } from "./LibrarySidebar";

/** Mount the workspace chrome around independently owned editor and navigation hosts. */
export function WorkspaceShell() {
  return (
    <>
      <a class="skip-link" href="#editor">
        Skip to document
      </a>
      <main id="auth-screen" class="auth-screen" aria-labelledby="auth-title" hidden>
        <section class="auth-card">
          <img src="/icon.svg" alt="" width="52" height="52" />
          <h1 id="auth-title">Log in to Folio</h1>
          <form id="auth-form">
            <div id="auth-invitation-field" hidden>
              <label for="auth-invitation">Invitation key</label>
              <input
                id="auth-invitation"
                type="text"
                autocomplete="off"
                autocapitalize="none"
                spellcheck="false"
                maxLength="128"
              />
            </div>
            <label for="auth-username">Username</label>
            <input
              id="auth-username"
              name="username"
              type="text"
              autocomplete="username"
              autocapitalize="none"
              spellcheck="false"
              required
              minLength="3"
              maxLength="64"
              pattern={"[A-Za-z0-9][A-Za-z0-9._\\-]{2,63}"}
            />
            <label for="auth-password">Password</label>
            <input id="auth-password" name="password" type="password" autocomplete="current-password" required />
            <div id="auth-confirm-field" hidden>
              <label for="auth-confirm">Confirm password</label>
              <input id="auth-confirm" name="confirm" type="password" autocomplete="new-password" />
            </div>
            <p id="auth-error" class="notice is-error" role="alert" hidden></p>
            <button id="auth-submit" class="button-primary auth-submit" type="submit">
              Log in
            </button>
            <button id="auth-use-invitation" class="auth-mode-switch" type="button" hidden>
              Create account with an invitation
            </button>
            <button id="auth-back-login" class="auth-mode-switch" type="button" hidden>
              Back to login
            </button>
          </form>
        </section>
      </main>
      <div id="app-shell" class="app-shell">
        <LibrarySidebar />
        <div
          id="sidebar-resizer"
          class="sidebar-resizer"
          role="separator"
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          aria-valuemin="210"
          aria-valuemax="420"
          aria-valuenow="260"
          tabIndex="0"
        ></div>
        <DocumentWorkspace />
      </div>
      <button
        id="sidebar-scrim"
        type="button"
        aria-label="Close sidebar"
        tabIndex="-1"
        hidden={!shell.sidebarOpen || !shell.compact}
      ></button>
      <div id="collaboration-cursors" aria-hidden="true"></div>
    </>
  );
}
