import { createEffect, createMemo, For, onMount, Show, untrack } from "solid-js";
import { createIcon } from "@folio/editor-runtime";
import { noteName, fileLabel, type FileEntry, type FileTree as Tree } from "@folio/model";
import { orderedChildren, orderId } from "../models/tree-order";
import { activePanelPath, libraryCatalog, libraryModel, libraryView, type PendingEntry } from "../state/library";

/** The glyph a reader chose for this entry, or the default for its kind. */
function entryIcon(path: string, fallback: string) {
  const name = libraryCatalog.icons.get(path) ?? fallback;
  const icon = createIcon(name);
  icon.dataset.icon = name;
  const trigger = document.createElement("span");
  trigger.className = "tree-entry-icon";
  trigger.setAttribute("role", "button");
  trigger.setAttribute("aria-label", "Change icon");
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.tabIndex = 0;
  trigger.append(icon);
  return trigger;
}

function AddEntry(props: { label: string; parent: string }) {
  return (
    <span class="directory-actions">
      <button
        type="button"
        tabIndex={-1}
        data-add-parent={props.parent}
        aria-label={`Add in ${props.label}`}
        aria-haspopup="menu"
        aria-controls="file-context-menu"
      >
        {createIcon("plus")}
      </button>
    </span>
  );
}

function EntryName(props: { entry: PendingEntry }) {
  const label = () => (props.entry.kind === "file" ? noteName(props.entry.name) : props.entry.name);
  function focusInput(input: HTMLInputElement) {
    onMount(() => {
      if (props.entry.phase !== "naming") return;
      input.focus();
      input.select();
    });
  }
  return (
    <li class="tree-file tree-pending" data-pending-key={props.entry.key}>
      <button
        type="button"
        class="file-button"
        data-local-open={props.entry.key}
        disabled={props.entry.kind === "directory" || props.entry.phase !== "syncing"}
      >
        {createIcon(props.entry.kind === "file" ? "file" : "folder")}
        <span class="file-name">{props.entry.title ?? label()}</span>
      </button>
      <Show when={props.entry.phase !== "syncing"}>
        <input
          ref={focusInput}
          class="tree-entry-name"
          data-naming-key={props.entry.key}
          value={label()}
          aria-label={props.entry.kind === "file" ? "File name" : "Folder name"}
          aria-invalid={Boolean(props.entry.error)}
          aria-description={props.entry.error}
          autocomplete="off"
          spellcheck={false}
        />
      </Show>
      <Show when={props.entry.error}>
        <small role="alert" class="tree-sync-error">
          {props.entry.error}
        </small>
      </Show>
    </li>
  );
}

function InlineRename(props: { path: string; folder?: boolean }) {
  const name = props.path.slice(props.path.lastIndexOf("/") + 1);
  const focus = (input: HTMLInputElement) =>
    onMount(() => {
      input.focus();
      input.select();
    });
  return (
    <div class="tree-inline-rename">
      <input
        ref={focus}
        class="tree-entry-name"
        data-rename-path={props.path}
        value={props.folder ? name : noteName(name)}
        aria-label={props.folder ? "Folder name" : "File name"}
        aria-invalid={Boolean(libraryView.rename?.error)}
        aria-description={libraryView.rename?.error}
        autocomplete="off"
        spellcheck={false}
      />
      <label>
        <input type="checkbox" data-update-links checked /> Update links
      </label>
      <Show when={libraryView.rename?.error}>
        <small role="alert" class="tree-sync-error">
          {libraryView.rename?.error}
        </small>
      </Show>
    </div>
  );
}

function FileRow(props: { file: Readonly<FileEntry> }) {
  return (
    <li class="tree-file">
      <Show when={libraryModel.renaming(props.file.path)}>
        <InlineRename path={props.file.path} />
      </Show>
      <button
        type="button"
        class="file-button"
        tabIndex={-1}
        draggable="true"
        aria-label={props.file.path}
        data-path={props.file.path}
        data-resource-id={props.file.id}
        data-entry-path={props.file.path}
        data-entry-kind="file"
        aria-current={!activePanelPath() && libraryModel.selected(props.file) ? "page" : undefined}
      >
        {entryIcon(props.file.path, "file")}
        <span class="file-name">
          {props.file.title ?? libraryModel.displayedName(props.file.path, fileLabel(props.file))}
        </span>
      </button>
      <AddEntry
        parent={props.file.path.slice(0, Math.max(0, props.file.path.lastIndexOf("/")))}
        label={fileLabel(props.file)}
      />
    </li>
  );
}

function Directory(props: { directory: Tree<Readonly<FileEntry>> }) {
  let details!: HTMLDetailsElement;
  createEffect(() => {
    const open = Boolean(libraryView.query.trim()) || libraryCatalog.expandedFolders.has(props.directory.path);
    if (details.open !== open) details.open = open;
  });
  const label = () => props.directory.title ?? libraryModel.displayedName(props.directory.path, props.directory.name);
  return (
    <li>
      <Show when={libraryModel.renaming(props.directory.path)}>
        <InlineRename path={props.directory.path} folder />
      </Show>
      <details class="directory" data-path={props.directory.path} ref={details}>
        <summary
          tabIndex={-1}
          draggable="true"
          data-entry-path={props.directory.path}
          data-resource-id={props.directory.id}
          data-entry-kind="directory"
          data-directory-path={props.directory.path}
        >
          {entryIcon(props.directory.path, "folder")}
          <span class="directory-label">{label()}</span>
          <AddEntry parent={props.directory.path} label={label()} />
        </summary>
        <ul
          class="file-branch"
          classList={{ "leaf-list": !props.directory.directories.length && props.directory.files.length >= 10 }}
          style={{ "--branch-rows": props.directory.files.length }}
        >
          <Branch tree={props.directory} />
        </ul>
      </details>
    </li>
  );
}

function Branch(props: { tree: Tree<Readonly<FileEntry>> }) {
  const saved = createMemo(() => libraryCatalog.order.get(orderId(props.tree)));
  return (
    <>
      <For each={libraryView.pending.filter((entry) => entry.parent === props.tree.path)}>
        {(entry) => <EntryName entry={entry} />}
      </For>
      <For each={orderedChildren(props.tree, saved())}>
        {(entry) =>
          "directories" in entry ? (
            <Directory directory={entry} />
          ) : entry.panel ? (
            <li class="tree-file">
              <Show when={libraryModel.renaming(entry.path)}>
                <InlineRename path={entry.path} />
              </Show>
              <button
                type="button"
                class="file-button"
                tabIndex={-1}
                data-panel-path={entry.path}
                data-entry-path={entry.path}
                data-entry-kind="file"
                aria-current={activePanelPath() === entry.path ? "page" : undefined}
                aria-label={entry.path}
              >
                {entryIcon(entry.path, /\.(pdf|xlsx)$/i.test(entry.name) ? "file" : "code")}
                <span class="file-name">{entry.name}</span>
              </button>
            </li>
          ) : (
            <FileRow file={entry} />
          )
        }
      </For>
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
