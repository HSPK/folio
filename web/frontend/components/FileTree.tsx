import { createEffect, For, Show, untrack } from "solid-js";
import { createIcon } from "@folio/editor-runtime";
import { fileDisplayKey, fileLabel, type FileEntry, type FileTree as Tree } from "../models/library";
import { libraryCatalog, libraryModel, libraryView } from "../state/library";

/** The glyph a reader chose for this entry, or the default for its kind. */
function entryIcon(path: string, fallback: string) {
  const name = libraryCatalog.icons.get(path) ?? fallback;
  const icon = createIcon(name);
  icon.dataset.icon = name;
  return icon;
}

function FileRow(props: { file: Readonly<FileEntry> }) {
  const duplicate = () => (libraryView.counts.get(fileDisplayKey(props.file)) ?? 0) > 1;
  return (
    <li>
      <button
        type="button"
        class="file-button"
        classList={{ "has-duplicate-title": duplicate() }}
        tabIndex={-1}
        draggable="true"
        aria-label={props.file.path}
        data-path={props.file.path}
        data-resource-id={props.file.id}
        data-entry-path={props.file.path}
        data-entry-kind="file"
        aria-current={libraryModel.selected(props.file) ? "page" : undefined}
      >
        {entryIcon(props.file.path, "file")}
        <span class="file-name">{fileLabel(props.file)}</span>
        <Show when={duplicate()}>
          <small class="file-path">{props.file.path}</small>
        </Show>
      </button>
    </li>
  );
}

function Directory(props: { directory: Tree<Readonly<FileEntry>> }) {
  let details!: HTMLDetailsElement;
  createEffect(() => {
    const open = Boolean(libraryView.query.trim()) || !libraryCatalog.collapsedFolders.has(props.directory.path);
    if (details.open !== open) details.open = open;
  });
  const label = () => props.directory.title ?? props.directory.name;
  return (
    <li>
      <details class="directory" data-path={props.directory.path} ref={details}>
        <summary
          tabIndex={-1}
          draggable="true"
          data-entry-path={props.directory.path}
          data-entry-kind="directory"
          data-directory-path={props.directory.path}
        >
          {entryIcon(props.directory.path, "folder")}
          <span class="directory-label">{label()}</span>
          <span class="directory-actions">
            <button type="button" tabIndex={-1} data-tree-action="note" aria-label={`New note in ${label()}`}>
              {createIcon("file-plus")}
            </button>
            <button type="button" tabIndex={-1} data-tree-action="folder" aria-label={`New folder in ${label()}`}>
              {createIcon("folder-plus")}
            </button>
          </span>
        </summary>
        <ul class="file-branch">
          <Branch tree={props.directory} />
        </ul>
      </details>
    </li>
  );
}

function Branch(props: { tree: Tree<Readonly<FileEntry>> }) {
  return (
    <>
      <For each={props.tree.directories}>{(directory) => <Directory directory={directory} />}</For>
      <For each={props.tree.files}>{(file) => <FileRow file={file} />}</For>
    </>
  );
}

export function FileTree() {
  let list!: HTMLUListElement;
  createEffect(() => {
    const request = libraryView.focusRequest;
    if (!request || libraryView.query.trim()) return;
    untrack(() => {
      const current = list.querySelector<HTMLButtonElement>('[aria-current="page"]');
      current?.scrollIntoView({ block: "nearest" });
      current?.focus({ preventScroll: true });
      libraryModel.consumeFocus(request);
    });
  });
  return (
    <ul id="file-list" class="file-list" ref={list}>
      <Branch tree={libraryView.tree} />
    </ul>
  );
}
