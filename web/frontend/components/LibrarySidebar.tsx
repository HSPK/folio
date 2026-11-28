/** Render the library navigation and project controls. */
export function LibrarySidebar() {
  let filter!: HTMLInputElement;
  return (
    <aside id="sidebar" class="sidebar" aria-label="Library" inert={!shell.sidebarOpen}>
      <header class="library-heading" data-directory-path="">
        <IconButton
          id="sidebar-hide"
          title="Close sidebar (Ctrl+Shift+L)"
          label="Close library sidebar"
          icon="sidebar"
          onClick={() => setSidebar(false, true)}
        />
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
            onInput={scheduleFileFilterRender}
          />
          <button id="sidebar-search-open" type="button" title="Search notes" aria-label="Search notes" hidden>
            <kbd>⌘/Ctrl P</kbd>
          </button>
        </div>
        <AppMenu id="new-menu" class="popup new-menu">
          <button
            type="button"
            popovertarget="new-menu-panel"
            class="icon-button"
            title="New"
            aria-label="New note or folder"
            aria-controls="new-menu-panel"
          >
            <svg data-icon="plus" aria-hidden="true"></svg>
          </button>
          <div id="new-menu-panel" class="popup-panel" popover="auto" role="group" aria-label="New" inert>
            <button
              id="new-note"
              type="button"
              data-menu-icon="file-plus"
              onClick={() => createTreeEntry("file")}
              disabled
            >
              New note
            </button>
            <button
              id="new-folder"
              type="button"
              data-menu-icon="folder-plus"
              onClick={() => createTreeEntry("directory")}
              disabled
            >
              New folder
            </button>
            <button id="new-from-template" type="button" data-menu-icon="file" onClick={() => openNewNote()} disabled>
              Templates…
            </button>
          </div>
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
        <IconButton
          id="sidebar-settings-open"
          title="Settings"
          label="Open sidebar settings"
          icon="settings"
          onClick={() => openSettings()}
        />
      </footer>
    </aside>
  );
}
import { Show } from "solid-js";
import { shell } from "../state/shell";
import { libraryModel, libraryView } from "../state/library";
import { FileTree } from "./FileTree";
import { AppMenu, IconButton } from "./primitives";
import { setSidebar } from "../runtime/accounts/authentication";
import { createTreeEntry } from "../runtime/navigation/creation";
import { openNewNote } from "../runtime/navigation/files";
import { scheduleFileFilterRender } from "../runtime/navigation/library";
import { openSettings } from "../runtime/preferences/settings";
