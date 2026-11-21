import { For, Show } from "solid-js";
import { shell, viewLabels } from "../state/shell";
import { AppMenu, AppMenuContent, AppMenuTrigger } from "./primitives";

const views = [
  ["rich", "edit"],
  ["editor", "code"],
  ["split", "columns"],
  ["preview", "book-open"],
] as const;

/** Render the document chrome around stable editor hosts. */
export function DocumentWorkspace() {
  // An untitled note is named by its path; the folder part recedes so the file name reads as the title.
  const folder = () => {
    const end = shell.title.endsWith(".md") ? shell.title.lastIndexOf("/") + 1 : 0;
    return shell.title.slice(0, end);
  };
  return (
    <main class="document-area" aria-labelledby="document-title">
      <button
        id="sidebar-toggle"
        class="icon-button"
        type="button"
        title="Show sidebar (Ctrl+Shift+L)"
        aria-label="Show sidebar"
        aria-controls="sidebar"
        aria-expanded={shell.sidebarOpen}
      >
        <svg data-icon="sidebar" aria-hidden="true"></svg>
      </button>
      <nav class="document-actions" aria-label="Document menu">
        <AppMenu id="more-menu" class="popup">
          <AppMenuTrigger
            class="icon-button more-menu-trigger"
            title={`${shell.title} · More actions`}
            aria-label={shell.modified ? "More actions · Unsaved changes" : "More actions"}
            aria-controls="more-actions-panel"
          >
            <svg data-icon="more-horizontal" aria-hidden="true"></svg>
            <span id="document-modified" role="img" aria-label="Unsaved changes" hidden={!shell.modified}></span>
          </AppMenuTrigger>
          <AppMenuContent id="more-actions-panel" class="popup-panel">
            <div class="more-menu-scroll">
              <h1 id="document-title" title={shell.title}>
                <span id="document-name">
                  <Show when={folder()}>
                    <span class="document-folder">{folder()}</span>
                  </Show>
                  {shell.title.slice(folder().length)}
                </span>
                {shell.modified ? " *" : ""}
              </h1>
              <div class="view-options" id="document-view-options" role="group" aria-label="Document view">
                <For each={views}>
                  {([view, icon]) => (
                    <button id={`view-${view}`} type="button" data-view={view} aria-pressed={shell.view === view}>
                      <svg data-icon={icon} aria-hidden="true"></svg>
                      {viewLabels[view]}
                    </button>
                  )}
                </For>
                <span id="view-label" class="visually-hidden">
                  {viewLabels[shell.view]}
                </span>
              </div>
              <div id="more-document-actions" class="menu-group" role="group" aria-label="Current note">
                <span class="menu-group-label" aria-hidden="true">
                  Current note
                </span>
                <div
                  id="collaboration-people"
                  class="collaboration-people"
                  role="group"
                  aria-label="People editing this note"
                ></div>
                <button id="collaboration-join" class="collaboration-join" type="button" hidden>
                  Collaborate
                </button>
                <button id="share-page" type="button" data-menu-icon="link" hidden>
                  Share page
                </button>
                <button id="copy-text" type="button" data-menu-icon="copy" disabled>
                  Copy Markdown
                </button>
                <button id="workspace-favorite" type="button" data-menu-icon="star" hidden>
                  Add to favorites
                </button>
                <button id="backlinks-open" type="button" data-menu-icon="arrow-left-right" disabled>
                  Backlinks
                </button>
                <button id="attachments-open" type="button" data-menu-icon="paperclip" hidden>
                  Attachments
                </button>
                <button id="document-tags-open" type="button" data-menu-icon="tag" disabled>
                  Edit tags
                </button>
              </div>
              <div id="more-workspace-actions" class="menu-group" role="group" aria-label="Workspace">
                <span class="menu-group-label" aria-hidden="true">
                  Workspace
                </span>
                <button
                  id="command-palette-open"
                  type="button"
                  data-menu-icon="command"
                  aria-label="Open command panel"
                  hidden
                >
                  Commands <kbd>Ctrl/Cmd+K</kbd>
                </button>
                <button id="workspace-search-open" type="button" data-menu-icon="search">
                  Search notes <kbd>Ctrl/Cmd+P</kbd>
                </button>
                <button id="workspace-open" type="button" data-menu-icon="clock" hidden>
                  Favorites and recent notes
                </button>
                <button id="shares-open" type="button" data-menu-icon="globe" hidden>
                  Public links
                </button>
              </div>
              <details id="more-recovery" class="menu-disclosure">
                <summary data-menu-icon="clock">
                  History and recovery
                  <svg data-icon="chevron-down" aria-hidden="true"></svg>
                </summary>
                <div id="more-recovery-actions" class="menu-disclosure-panel">
                  <button id="history-open" type="button" data-menu-icon="clock" hidden>
                    Version history
                  </button>
                  <button id="drafts-open" type="button" data-menu-icon="file">
                    Recover unsaved drafts
                  </button>
                  <button id="trash-open" type="button" data-menu-icon="trash" hidden>
                    Recycle bin
                  </button>
                  <button id="document-trash" type="button" data-menu-icon="file-minus" hidden>
                    Move note to recycle bin
                  </button>
                  <button id="reload-document" type="button" data-menu-icon="refresh" disabled>
                    Reload from disk
                  </button>
                </div>
              </details>
              <details id="compact-layout-menu" class="menu-disclosure">
                <summary data-menu-icon="expand-width">
                  Page width
                  <svg data-icon="chevron-down" aria-hidden="true"></svg>
                </summary>
                <div class="menu-disclosure-panel" role="group" aria-label="Page width">
                  <button type="button" data-page-width="focused" aria-pressed="false">
                    Focused
                  </button>
                  <button type="button" data-page-width="balanced" aria-pressed="true">
                    Balanced
                  </button>
                  <button type="button" data-page-width="wide" aria-pressed="false">
                    Wide
                  </button>
                </div>
              </details>
            </div>
            <div class="menu-group more-menu-application" role="group" aria-label="Application">
              <button id="settings-open" type="button" data-menu-icon="settings" aria-label="Open settings">
                Settings
              </button>
              <button id="focus-mode" type="button" data-menu-icon="maximize" aria-pressed="false">
                Distraction free
              </button>
              <button id="about-open" type="button" data-menu-icon="circle-help">
                About Folio
              </button>
              <button id="logout" type="button" data-menu-icon="log-out" hidden>
                Log out
              </button>
            </div>
            <div class="menu-group menu-stats" role="group" aria-label="Statistics" hidden={!shell.statistics}>
              <p class="menu-stat" data-menu-icon="text">
                <span id="editor-stats" title={shell.statisticsDetail}>
                  {shell.statistics}
                </span>
                <small>{shell.statisticsDetail.split(" · ").slice(0, 2).join(" · ")}</small>
              </p>
            </div>
          </AppMenuContent>
        </AppMenu>
      </nav>
      <div class="document-alerts">
        <div id="collaboration-message" class="notice" role="status" hidden></div>
        <div id="connection-message" class="notice" role="alert" hidden></div>
        <div id="appearance-message" class="notice is-warning" role="status" hidden></div>
        <div id="conflict-message" class="notice is-warning" role="alert" hidden></div>
        <div id="root-warning" class="notice is-warning" role="alert" hidden></div>
        <div id="loading-message" class="notice" role="status" hidden></div>
        <div id="size-warning" class="notice is-error" role="alert" hidden></div>
        <div id="rich-warning" class="notice is-warning" role="status" hidden></div>
        <div id="image-message" class="notice" role="status" hidden></div>
        <div id="table-message" class="notice" role="status" hidden></div>
        <p id="metadata-message" class="notice" role="status" data-status-source hidden></p>
      </div>
      <section id="empty-document" class="empty-document" hidden={shell.hasDocument}>
        <svg data-icon="file" aria-hidden="true"></svg>
        <button id="empty-new-note" type="button" disabled>
          New note
        </button>
      </section>
      <div id="document-panes" class="document-panes" data-view={shell.view} hidden={!shell.hasDocument}>
        <section class="rich-pane" aria-label="Live formatted editing">
          <div id="rich-editor" class="rich-editor"></div>
        </section>
        <section class="editor-pane" aria-label="Markdown source" data-overlayscrollbars-initialize>
          <label for="editor" class="visually-hidden">
            Markdown source
          </label>
          <textarea
            id="editor"
            class="editor"
            spellcheck="false"
            autocomplete="off"
            autocapitalize="off"
            aria-describedby="size-warning"
            disabled
          ></textarea>
        </section>
        <section class="preview-pane" aria-label="Markdown preview" data-overlayscrollbars-initialize>
          <span id="preview-status" class="visually-hidden" role="status"></span>
          <article id="preview" class="markdown-body preview-body" tabIndex="0" aria-label="Markdown preview"></article>
        </section>
      </div>
      <aside id="document-outline" class="document-outline" aria-label="On this page" hidden>
        <button
          id="outline-tab"
          class="outline-trigger"
          type="button"
          aria-label="Document outline"
          aria-controls="outline-panel"
          aria-expanded="false"
          title="Document outline (Ctrl/Cmd+Shift+1)"
        >
          <span id="outline-rail" class="outline-rail" aria-hidden="true"></span>
        </button>
        <section
          id="outline-panel"
          class="document-outline-panel"
          aria-label="Heading navigation"
          aria-hidden="true"
          inert
          hidden
        >
          <p id="outline-empty" class="tree-message">
            No headings
          </p>
          <div id="outline-scroll-frame" class="scroll-frame" data-overlayscrollbars-initialize>
            <nav id="outline-scroll" aria-label="Document outline">
              <ul id="outline-list" class="outline-list"></ul>
            </nav>
          </div>
        </section>
      </aside>
      <footer class="status-bar">
        <span id="dirty-indicator" class="dirty-indicator" data-state="empty" role="status" hidden></span>
        <span id="document-message" class="status-message" role="status" hidden></span>
        <span id="copy-status" class="visually-hidden" role="status"></span>
        <span id="connection-label" class="connection-label" role="status" hidden>
          Connecting…
        </span>
      </footer>
    </main>
  );
}
