import { batch, createSelector, createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { buildFileTree, filterNotes, type FileEntry, type FileTree } from "@folio/model";
import type { TreeOrder } from "../models/tree-order";

type File = Readonly<FileEntry>;
export const [activePanelPath, setActivePanelPath] = createSignal<string | null>(null);

export interface PendingEntry {
  key: string;
  parent: string;
  name: string;
  kind: "file" | "directory";
  phase: "naming" | "syncing" | "failed";
  content?: string;
  duplicateOf?: string;
  title?: string;
  error?: string;
}

interface LibraryCatalog {
  panelFiles: readonly File[];
  files: readonly File[];
  directories: readonly File[];
  loaded: boolean;
  loading: boolean;
  error: string;
  truncated: boolean;
  expandedFolders: ReadonlySet<string>;
  order: TreeOrder;
  // Reader-chosen icon names by entry path; entries without one use the default glyph.
  icons: ReadonlyMap<string, string>;
}

interface LibraryView {
  tree: FileTree<File>;
  // Applied query; the native input may be ahead until the scheduled filter update.
  query: string;
  selectedId: string | null;
  selectedPath: string | null;
  outsideFilter: boolean;
  focusRequest: symbol | null;
  pending: readonly PendingEntry[];
  rename: { path: string; kind: PendingEntry["kind"]; id: string; error?: string } | null;
  moving: { path: string; destination: string } | null;
}

const emptyCatalog = (): LibraryCatalog => ({
  panelFiles: [],
  files: [],
  directories: [],
  loaded: false,
  loading: false,
  error: "",
  truncated: false,
  expandedFolders: new Set(),
  order: new Map(),
  icons: new Map(),
});
const emptyView = (): LibraryView => ({
  tree: buildFileTree([]),
  query: "",
  selectedId: null,
  selectedPath: null,
  outsideFilter: false,
  focusRequest: null,
  pending: [],
  rename: null,
  moving: null,
});

/** Own catalog identity and its immutable presentation independently of application DOM handles. */
export function createLibraryModel() {
  const [data, setData] = createStore(emptyCatalog());
  const [presentation, setPresentation] = createStore(emptyView());
  const catalog: Readonly<LibraryCatalog> = data;
  const view: Readonly<LibraryView> = presentation;
  let visible: readonly File[] = [];
  let matching: readonly File[] = [];
  let catalogVersion = 0;
  let expandedObserver: ((paths: ReadonlySet<string>) => void) | null = null;
  const selected = (file: File) => {
    const id = view.selectedId;
    return id && file.id ? file.id === id : file.path === view.selectedPath;
  };
  const outside = () =>
    setPresentation("outsideFilter", Boolean(view.query.trim() && visible.some(selected) && !matching.some(selected)));

  function setCollapsed(path: string, collapsed: boolean) {
    if (catalog.expandedFolders.has(path) !== collapsed) return;
    const next = new Set(catalog.expandedFolders);
    if (collapsed) next.delete(path);
    else next.add(path);
    setData("expandedFolders", next);
    expandedObserver?.(next);
  }

  return {
    catalog,
    view,
    get version() {
      return catalogVersion;
    },
    get visibleCount() {
      return visible.length;
    },
    get matchingCount() {
      return matching.length;
    },
    reset(preserveQuery = false) {
      catalogVersion++;
      const query = preserveQuery ? view.query : "";
      visible = matching = [];
      batch(() => {
        setData(emptyCatalog());
        setPresentation({ ...emptyView(), query });
      });
    },
    update(patch: Partial<Pick<LibraryCatalog, "loaded" | "loading" | "error" | "truncated">>) {
      setData(patch);
    },
    replace(
      files: readonly FileEntry[],
      directories: readonly FileEntry[],
      truncated: boolean,
      panels: readonly FileEntry[] = [],
    ) {
      catalogVersion++;
      batch(() => {
        setData(
          "panelFiles",
          reconcile(
            panels.map((f) => ({ ...f })),
            { key: "path" },
          ),
        );
        setData(
          "files",
          reconcile(
            files.map((file) => ({ ...file })),
            { key: "path" },
          ),
        );
        setData(
          "directories",
          reconcile(
            directories.map((directory) => ({ ...directory })),
            { key: "path" },
          ),
        );
        setData({ loaded: true, error: "", truncated });
      });
    },
    setTitle(path: string, title: string | null) {
      catalogVersion++;
      setData(
        "files",
        catalog.files.map((file) => (file.path === path ? { ...file, title } : file)),
      );
    },
    project(files: readonly File[], directories: readonly File[], query: string) {
      visible = files;
      matching = filterNotes(files, query);
      const tree = buildFileTree(matching, directories, !query.trim());
      batch(() => {
        setPresentation("tree", reconcile(tree, { key: "path" }));
        setPresentation("query", query);
        outside();
      });
    },
    select(document: { id: string; path: string } | null) {
      if (view.selectedId === (document?.id ?? null) && view.selectedPath === (document?.path ?? null)) return;
      batch(() => {
        setPresentation({ selectedId: document?.id ?? null, selectedPath: document?.path ?? null });
        outside();
      });
    },
    selected,
    setCollapsed,
    setOrder(order: TreeOrder) {
      setData("order", order);
    },
    stage(entry: PendingEntry) {
      setPresentation("pending", (entries) => [...entries, entry]);
    },
    renaming: createSelector(() => view.rename?.path),
    rename(entry: LibraryView["rename"]) {
      setPresentation("rename", entry);
    },
    renameError(error: string) {
      if (view.rename) setPresentation("rename", "error", error);
    },
    updatePending(key: string, patch: Partial<PendingEntry>) {
      setPresentation("pending", (entry) => entry.key === key, patch);
    },
    unstage(key: string) {
      setPresentation("pending", (entries) => entries.filter((entry) => entry.key !== key));
    },
    moving(path: string, destination: string) {
      setPresentation("moving", { path, destination });
    },
    finishMove(path: string) {
      if (view.moving?.path === path) setPresentation("moving", null);
    },
    displayedName(path: string, fallback: string) {
      return view.moving?.path === path ? (view.moving.destination.split("/").at(-1) ?? fallback) : fallback;
    },
    publishCreated(path: string, id: string | undefined, kind: PendingEntry["kind"]) {
      catalogVersion++;
      const collection = kind === "file" ? "files" : "directories";
      if (!catalog[collection].some((entry) => entry.path === path))
        setData(collection, (entries) => [...entries, { path, name: path.split("/").at(-1) ?? path, id }]);
    },
    /** Adopt remembered folder states without reporting them back as a writer's change. */
    restoreExpanded(paths: Iterable<string>) {
      setData("expandedFolders", new Set(paths));
    },
    /** Replace the chosen entry icons; the caller owns remembering them. */
    setIcons(icons: ReadonlyMap<string, string>) {
      setData("icons", icons);
    },
    /** Report folder changes made by the writer so a storage adapter can remember them. */
    observeExpanded(observer: ((paths: ReadonlySet<string>) => void) | null) {
      expandedObserver = observer;
    },
    focusCurrent() {
      const file = catalog.files.find(selected);
      if (!file) return;
      const parents = file.path.split("/").slice(0, -1);
      let path = "";
      batch(() => {
        for (const part of parents) {
          path = path ? `${path}/${part}` : part;
          setCollapsed(path, false);
        }
        setPresentation("focusRequest", Symbol("library-focus"));
      });
    },
    consumeFocus(request: symbol) {
      if (view.focusRequest === request) setPresentation("focusRequest", null);
    },
  };
}

export const libraryModel = createLibraryModel();
export const libraryCatalog = libraryModel.catalog;
export const libraryView = libraryModel.view;
