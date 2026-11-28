import { For, Show } from "solid-js";
import { primaryShortcut } from "../../shared/keyboard";
import { shell, viewLabels } from "../state/shell";
import { activePanelPath } from "../state/library";
import { documentSession } from "../state/document";
import { readNoteRoute } from "@folio/model";
import { logout, setSidebar, toggleFocusMode } from "../runtime/accounts/authentication";
import { appState } from "../runtime/core/bootstrap";
import { openCommandPanel } from "../runtime/core/commands";
import { setPageWidth } from "../runtime/core/layout";
import { navigateTo } from "../runtime/documents/navigation";
import { createTreeEntry } from "../runtime/navigation/creation";
import { copyText, setView } from "../runtime/navigation/files";
import { element } from "../types/elements";
import { AppMenu, IconButton } from "./primitives";

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
    <main
      class="document-area"
      data-file-open={activePanelPath() ? "" : undefined}
      aria-labelledby={activePanelPath() ? "panel-title" : "document-title"}
    >
      <IconButton
        id="sidebar-toggle"
        title={`Show sidebar (${primaryShortcut("Shift+L")})`}
        label="Show sidebar"
        icon="sidebar"
        aria-controls="sidebar"
        aria-expanded={shell.sidebarOpen}
        onClick={() => setSidebar(true, true)}
      />
      <section id="workspace-file-panel" hidden={!activePanelPath()} aria-labelledby="panel-title">
        <div class="file-panel-surface">
          <header class="panel-header">
            <div class="panel-heading">
              <small id="panel-kind"></small>
              <h2 id="panel-title"></h2>
            </div>
            <div id="panel-tools"></div>
            <IconButton
              id="panel-more"
              label="File actions"
              icon="more-horizontal"
              title="More actions"
              aria-haspopup="menu"
              aria-controls="file-context-menu"
            />
            <IconButton id="panel-close" title="Close file" label="Close file panel" icon="x" />
          </header>
          <div id="panel-body" tabIndex={-1}></div>
        </div>
        <div id="panel-sheets" role="tablist" aria-label="Worksheets"></div>
        <p id="panel-status" role="status"></p>
      </section>
      <nav class="document-actions" aria-label="Document menu">
        <AppMenu id="more-menu" class="popup">
          <button
            type="button"
            popovertarget="more-actions-panel"
            class="icon-button more-menu-trigger"
            title={`${shell.title} · More actions`}
            aria-label={shell.modified ? "More actions · Unsaved changes" : "More actions"}
            aria-controls="more-actions-panel"
          >
            <svg data-icon="more-horizontal" aria-hidden="true"></svg>
            <span id="document-modified" role="img" aria-label="Unsaved changes" hidden={!shell.modified}></span>
          </button>
          <div id="more-actions-panel" class="popup-panel" popover="auto" inert>
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
                    <button
                      id={`view-${view}`}
                      type="button"
                      data-view={view}
                      aria-pressed={shell.view === view}
                      onClick={() => setView(view, true)}
                    >
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
                <button id="copy-text" type="button" data-menu-icon="copy" onClick={() => copyText()} disabled>
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
                  onClick={openCommandPanel}
                  hidden
                >
                  Commands <kbd>{primaryShortcut("K")}</kbd>
                </button>
                <button id="workspace-search-open" type="button" data-menu-icon="search">
                  Search notes <kbd>{primaryShortcut("P")}</kbd>
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
                  <button
                    id="reload-document"
                    type="button"
                    data-menu-icon="refresh"
                    disabled
                    onClick={() => {
                      if (documentSession.current)
                        void navigateTo(documentSession.current.id, readNoteRoute(appState.committedUrl).hash, {
                          mode: "replace",
                          reload: true,
                        });
                    }}
                  >
                    Reload from disk
                  </button>
                </div>
              </details>
              <details id="reader-options" class="menu-disclosure" hidden>
                <summary data-menu-icon="settings">
                  Reading settings <svg data-icon="chevron-down" aria-hidden="true"></svg>
                </summary>
                <div class="reader-options">
                  <label>
                    Theme{" "}
                    <select id="reader-theme">
                      <option value="system">System</option>
                      <option value="light">Light</option>
                      <option value="dark">Dark</option>
                    </select>
                  </label>
                  <label>
                    Text size{" "}
                    <select id="reader-size">
                      <option value="15">Small</option>
                      <option value="17" selected>
                        Standard
                      </option>
                      <option value="20">Large</option>
                    </select>
                  </label>
                </div>
              </details>
              <details id="compact-layout-menu" class="menu-disclosure">
                <summary data-menu-icon="expand-width">
                  Page width
                  <svg data-icon="chevron-down" aria-hidden="true"></svg>
                </summary>
                <div class="menu-disclosure-panel" role="group" aria-label="Page width">
                  <button
                    type="button"
                    data-page-width="focused"
                    aria-pressed="false"
                    onClick={() => setPageWidth("focused", true)}
                  >
                    Focused
                  </button>
                  <button
                    type="button"
                    data-page-width="balanced"
                    aria-pressed="true"
                    onClick={() => setPageWidth("balanced", true)}
                  >
                    Balanced
                  </button>
                  <button
                    type="button"
                    data-page-width="wide"
                    aria-pressed="false"
                    onClick={() => setPageWidth("wide", true)}
                  >
                    Wide
                  </button>
                </div>
              </details>
            </div>
            <div class="menu-group more-menu-application" role="group" aria-label="Application">
              <button id="settings-open" type="button" data-menu-icon="settings" aria-label="Open settings">
                Settings
              </button>
              <button
                id="focus-mode"
                type="button"
                data-menu-icon="maximize"
                aria-pressed="false"
                onClick={toggleFocusMode}
              >
                Distraction free
              </button>
              <button id="about-open" type="button" data-menu-icon="circle-help">
                About Folio
              </button>
              <button id="logout" type="button" data-menu-icon="log-out" onClick={logout} hidden>
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
          </div>
        </AppMenu>
      </nav>
      <div class="document-alerts">
        <div id="collaboration-message" class="notice" role="status" hidden></div>
        <div id="connection-message" class="notice" role="alert" hidden></div>
        <div id="appearance-message" class="notice is-warning" role="status" hidden></div>
        <div id="root-warning" class="notice is-warning" role="alert" hidden></div>
        <div id="loading-message" class="notice" role="status" hidden></div>
        <div id="size-warning" class="notice is-error" role="alert" hidden></div>
        <div id="rich-warning" class="notice is-warning" role="status" hidden></div>
        <div id="image-message" class="notice" role="status" hidden></div>
        <div id="table-message" class="notice" role="status" hidden></div>
        <p id="metadata-message" class="notice" role="status" data-status-source hidden></p>
      </div>
      <div class="document-conflict">
        <div id="conflict-message" role="status" hidden></div>
        <button id="conflict-copy" type="button" onClick={() => copyText(true)}>
          Copy my edits
        </button>
        <button id="conflict-latest" type="button" onClick={() => element("reload-document").click()}>
          Use latest
        </button>
      </div>
      <section id="empty-document" class="empty-document" hidden={shell.hasDocument}>
        <svg data-icon="file" aria-hidden="true"></svg>
        <button id="empty-new-note" type="button" onClick={() => createTreeEntry("file")} disabled>
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
          title={`Document outline (${primaryShortcut("Shift+1")})`}
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
