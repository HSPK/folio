import { shell, viewLabels } from "../state/shell";
import { AppMenu, AppMenuContent, AppMenuTrigger } from "./primitives";

/** Render the document chrome around stable editor hosts. */
export function DocumentWorkspace() {
  return (
    <main class="document-area" aria-labelledby="document-title">
      <header class="document-header">
        <button
          id="sidebar-toggle"
          class="icon-button"
          type="button"
          title="Toggle sidebar (Ctrl+Shift+L)"
          aria-label="Toggle sidebar"
          aria-controls="sidebar"
          aria-expanded={shell.sidebarOpen}
        >
          <svg data-icon="sidebar" aria-hidden="true"></svg>
        </button>
        <h1 id="document-title">
          <span id="document-name">{shell.title}</span>
          <span id="document-modified" role="img" aria-label="Unsaved changes" hidden={!shell.modified}>
            {shell.modified ? " *" : ""}
          </span>
        </h1>
        <div
          id="collaboration-people"
          class="collaboration-people"
          role="group"
          aria-label="People editing this note"
        ></div>
        <nav class="document-actions menu-bar" aria-label="Document menu">
          <button id="collaboration-join" class="collaboration-join" type="button" hidden>
            Collaborate
          </button>
          <AppMenu id="view-menu" class="popup menu-bar-item">
            <AppMenuTrigger
              class="view-menu-trigger"
              title="Switch document view"
              aria-controls="document-view-options"
            >
              <span id="view-label">{viewLabels[shell.view]}</span>
              <svg data-icon="chevron-down" aria-hidden="true"></svg>
            </AppMenuTrigger>
            <AppMenuContent
              id="document-view-options"
              class="popup-panel view-options"
              role="group"
              aria-label="Document view"
            >
              <button id="view-rich" type="button" data-view="rich" aria-pressed="true">
                Live
              </button>
              <button id="view-editor" type="button" data-view="editor" aria-pressed="false">
                Source
              </button>
              <button id="view-split" type="button" data-view="split" aria-pressed="false">
                Compare
              </button>
              <button id="view-preview" type="button" data-view="preview" aria-pressed="false">
                Read
              </button>
            </AppMenuContent>
          </AppMenu>
          <AppMenu id="layout-menu" class="popup layout-menu">
            <AppMenuTrigger class="icon-button" title="Page width" aria-label="Adjust page width">
              <svg data-icon="expand-width" aria-hidden="true"></svg>
            </AppMenuTrigger>
            <AppMenuContent class="popup-panel layout-options" role="group" aria-label="Page width">
              <button type="button" data-page-width="focused" aria-pressed="false">
                Focused
              </button>
              <button type="button" data-page-width="balanced" aria-pressed="true">
                Balanced
              </button>
              <button type="button" data-page-width="wide" aria-pressed="false">
                Wide
              </button>
            </AppMenuContent>
          </AppMenu>
          <button
            id="command-palette-open"
            class="icon-button"
            type="button"
            title="Commands (Ctrl+K)"
            aria-label="Open command panel"
            hidden
          >
            <svg data-icon="command" aria-hidden="true"></svg>
          </button>
          <AppMenu id="more-menu" class="popup">
            <AppMenuTrigger
              class="icon-button more-menu-trigger"
              title="More actions"
              aria-label="More actions"
              aria-controls="more-actions-panel"
            >
              <svg data-icon="more-horizontal" aria-hidden="true"></svg>
            </AppMenuTrigger>
            <AppMenuContent id="more-actions-panel" class="popup-panel">
              <div class="more-menu-scroll">
                <div id="more-document-actions" class="menu-group" role="group" aria-label="Current note">
                  <span class="menu-group-label" aria-hidden="true">
                    Current note
                  </span>
                  <button id="share-page" type="button" hidden>
                    Share page
                  </button>
                  <button id="copy-text" type="button" disabled>
                    Copy Markdown
                  </button>
                  <button id="workspace-favorite" type="button" hidden>
                    Add to favorites
                  </button>
                  <button id="backlinks-open" type="button" disabled>
                    Backlinks
                  </button>
                  <button id="attachments-open" type="button" hidden>
                    Attachments
                  </button>
                  <button id="document-tags-open" type="button" disabled>
                    Edit tags
                  </button>
                </div>
                <div id="more-workspace-actions" class="menu-group" role="group" aria-label="Workspace">
                  <span class="menu-group-label" aria-hidden="true">
                    Workspace
                  </span>
                  <button id="workspace-search-open" type="button">
                    Search notes <kbd>Ctrl/Cmd+P</kbd>
                  </button>
                  <button id="workspace-open" type="button" hidden>
                    Favorites and recent notes
                  </button>
                  <button id="shares-open" type="button" hidden>
                    Public links
                  </button>
                </div>
                <details id="more-recovery" class="menu-disclosure">
                  <summary>
                    History and recovery
                    <svg data-icon="chevron-down" aria-hidden="true"></svg>
                  </summary>
                  <div id="more-recovery-actions" class="menu-disclosure-panel">
                    <button id="history-open" type="button" hidden>
                      Version history
                    </button>
                    <button id="drafts-open" type="button">
                      Recover unsaved drafts
                    </button>
                    <button id="trash-open" type="button" hidden>
                      Recycle bin
                    </button>
                    <button id="document-trash" type="button" hidden>
                      Move note to recycle bin
                    </button>
                    <button id="reload-document" type="button" disabled>
                      Reload from disk
                    </button>
                  </div>
                </details>
                <details id="compact-layout-menu" class="menu-disclosure compact-layout-menu">
                  <summary>
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
                <button id="settings-open" type="button" aria-label="Open settings">
                  Settings
                </button>
                <button id="focus-mode" type="button" aria-pressed="false">
                  Distraction free
                </button>
                <button id="about-open" type="button">
                  About Folio
                </button>
                <button id="logout" type="button" hidden>
                  Log out
                </button>
              </div>
            </AppMenuContent>
          </AppMenu>
        </nav>
      </header>
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
        <div class="status-right">
          <span id="editor-stats" title={shell.statisticsDetail}>
            {shell.statistics}
          </span>
          <span id="connection-label" class="connection-label" role="status" hidden>
            Connecting…
          </span>
          <button id="reconnect" type="button" disabled>
            Reconnect
          </button>
        </div>
      </footer>
    </main>
  );
}
