import { For } from "solid-js";
import { commandIndex, visibleCommands, filterCommands, runCommand, selectCommand } from "../runtime/core/commands";
import { element } from "../types/elements";

/** Provide persistent command, account, about, and confirmation surfaces. */
export function ApplicationDialogs() {
  return (
    <>
      <dialog id="command-dialog" class="command-dialog" aria-labelledby="command-title">
        <form
          id="command-form"
          onSubmit={(event) => {
            event.preventDefault();
            runCommand();
          }}
        >
          <div class="command-search">
            <svg data-icon="search" aria-hidden="true"></svg>
            <label id="command-title" class="visually-hidden" for="command-query">
              Commands
            </label>
            <input
              id="command-query"
              type="search"
              placeholder="Search notes and commands"
              autocomplete="off"
              spellcheck="false"
              onInput={filterCommands}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  selectCommand(commandIndex() + (event.key === "ArrowDown" ? 1 : -1));
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  runCommand();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  element("command-dialog").close();
                }
              }}
            />
            <button
              id="command-close"
              type="button"
              aria-label="Close command panel"
              onClick={() => element("command-dialog").close()}
            >
              Esc
            </button>
          </div>
          <div id="command-list" class="command-list" role="listbox" aria-label="Commands">
            <For each={visibleCommands()}>
              {(command, index) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={commandIndex() === index()}
                  onPointerMove={() => selectCommand(index())}
                  onClick={() => runCommand(index())}
                >
                  <span class="command-name">{command.name}</span>
                  {command.key && <span class="command-key">{command.key}</span>}
                </button>
              )}
            </For>
          </div>
          <p id="command-empty" class="command-empty" hidden={visibleCommands().length > 0}>
            No matching notes or commands
          </p>
        </form>
      </dialog>
      <dialog id="about-dialog" class="about-dialog" aria-labelledby="about-title">
        <h2 id="about-title">Folio</h2>
        <p>Local-first Markdown workspace</p>
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
      </dialog>
      <dialog id="account-password-dialog" aria-labelledby="account-password-title">
        <form id="account-password-form">
          <h2 id="account-password-title">Reset password</h2>
          <label for="account-password">New password</label>
          <input
            id="account-password"
            type="password"
            autocomplete="new-password"
            aria-describedby="account-password-error"
            required
          />
          <p id="account-password-error" class="notice is-error" role="alert" data-inline-status hidden></p>
          <div class="dialog-actions">
            <button id="account-password-cancel" type="button">
              Cancel
            </button>
            <button class="button-primary" type="submit">
              Reset password
            </button>
          </div>
        </form>
      </dialog>
      <dialog id="confirmation-dialog" class="confirmation-dialog" aria-labelledby="confirmation-title">
        <h2 id="confirmation-title">Confirm action</h2>
      </dialog>
    </>
  );
}
