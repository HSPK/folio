/** Render the library navigation and project controls. */
export function LibrarySidebar() {
  let filter!: HTMLInputElement;
  return (
    <aside id="sidebar" class="sidebar" aria-label="Library" inert={!shell.sidebarOpen}>
      <header class="library-heading" data-directory-path="">
        <button
          id="sidebar-hide"
          class="icon-button"
          type="button"
          title="Close sidebar"
          aria-label="Close library sidebar"
        >
          <svg data-icon="sidebar" aria-hidden="true"></svg>
        </button>
        <div class="library-actions">
          <button id="new-note" class="icon-button" type="button" title="New note" aria-label="New note" disabled>
            <svg data-icon="file-plus" aria-hidden="true"></svg>
          </button>
          <button id="new-folder" class="icon-button" type="button" title="New folder" aria-label="New folder" disabled>
            <svg data-icon="folder-plus" aria-hidden="true"></svg>
          </button>
          <button
            id="refresh-files"
            class="icon-button"
            type="button"
            title="Refresh files"
            aria-label="Refresh files"
            disabled
          >
            <svg data-icon="refresh" aria-hidden="true"></svg>
          </button>
        </div>
      </header>
      <div class="search-field sidebar-search">
        <svg data-icon="search" aria-hidden="true"></svg>
        <label class="visually-hidden" for="file-filter">
          Search files
        </label>
        <input
          id="file-filter"
          ref={filter}
          type="search"
          placeholder="Find a note"
          autocomplete="off"
          spellcheck="false"
          aria-controls="file-list"
        />
        <button id="sidebar-search-open" type="button" title="Search notes" aria-label="Search notes" hidden>
          <kbd>⌘/Ctrl P</kbd>
        </button>
      </div>
      <Show when={libraryView.outsideFilter}>
        <div id="filtered-current-note" class="file-filter-context">
          <span>The open note is outside this filter.</span>
          <button
            type="button"
            onClick={() => {
              filter.value = "";
              filter.dispatchEvent(new Event("input", { bubbles: true }));
              libraryModel.focusCurrent();
            }}
          >
            Show current note
          </button>
        </div>
      </Show>
      <nav class="sidebar-navigation" aria-label="Library navigation">
        <button id="files-tab" aria-controls="files-panel" aria-pressed="true" type="button">
          <svg data-icon="folder" aria-hidden="true"></svg>
          <span>Notes</span>
        </button>
      </nav>
      <nav id="library-shortcuts" class="library-shortcuts" aria-label="Find notes" hidden>
        <button id="sidebar-workspace-open" type="button">
          <svg data-icon="list" aria-hidden="true"></svg>
          <span>Favorites and recent</span>
        </button>
      </nav>
      <section id="files-panel" class="sidebar-panel" aria-labelledby="files-tab">
        <h2 class="sidebar-section-label">Pages</h2>
        <p id="tree-message" class="tree-message" role="status">
          Connecting to your notes…
        </p>
        <p id="tree-limit" class="notice tree-limit" role="status" hidden></p>
        <div id="files-scroll-frame" class="scroll-frame" data-overlayscrollbars-initialize>
          <nav id="file-nav" class="file-nav" aria-label="Markdown notes">
            <FileTree />
          </nav>
        </div>
      </section>
      <footer class="sidebar-footer">
        <div class="sidebar-workspace">
          <span class="sidebar-avatar" aria-hidden="true">
            F
          </span>
          <span id="app-name" class="app-name">
            Folio
          </span>
          <button
            id="projects-open"
            class="app-name project-switcher"
            type="button"
            title="Switch or manage projects"
            hidden
          >
            Projects
          </button>
        </div>
        <button
          id="sidebar-settings-open"
          class="icon-button"
          type="button"
          title="Settings"
          aria-label="Open sidebar settings"
        >
          <svg data-icon="settings" aria-hidden="true"></svg>
        </button>
      </footer>
    </aside>
  );
}
import { Show } from "solid-js";
import { shell } from "../state/shell";
import { libraryModel, libraryView } from "../state/library";
import { FileTree } from "./FileTree";
