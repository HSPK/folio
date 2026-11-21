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
          title="Close sidebar (Ctrl+Shift+L)"
          aria-label="Close library sidebar"
        >
          <svg data-icon="sidebar" aria-hidden="true"></svg>
        </button>
      </header>
      <div class="sidebar-tools">
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
        <AppMenu id="new-menu" class="popup new-menu">
          <AppMenuTrigger
            class="icon-button"
            title="New"
            aria-label="New note or folder"
            aria-controls="new-menu-panel"
          >
            <svg data-icon="plus" aria-hidden="true"></svg>
          </AppMenuTrigger>
          <AppMenuContent id="new-menu-panel" class="popup-panel" role="group" aria-label="New">
            <button id="new-note" type="button" data-menu-icon="file-plus" disabled>
              New note
            </button>
            <button id="new-folder" type="button" data-menu-icon="folder-plus" disabled>
              New folder
            </button>
          </AppMenuContent>
        </AppMenu>
      </div>
      <Show when={libraryView.outsideFilter}>
        <div id="filtered-current-note" class="file-filter-context">
          <span>Open note is filtered out</span>
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
      <section id="files-panel" class="sidebar-panel" aria-label="Notes">
        <p id="tree-message" class="tree-message" role="status" hidden></p>
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
import { AppMenu, AppMenuContent, AppMenuTrigger } from "./primitives";
