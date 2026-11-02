import { batch } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { buildFileTree, countFileDisplays, filterNotes, type FileEntry, type FileTree } from "../models/library";

type File = Readonly<FileEntry>;

interface LibraryCatalog {
  files: readonly File[];
  directories: readonly File[];
  loaded: boolean;
  loading: boolean;
  error: string;
  truncated: boolean;
  collapsedFolders: ReadonlySet<string>;
}

interface LibraryView {
  tree: FileTree<File>;
  // Applied query; the native input may be ahead until the scheduled filter update.
  query: string;
  counts: ReadonlyMap<string, number>;
  selectedId: string | null;
  selectedPath: string | null;
  outsideFilter: boolean;
  focusRequest: symbol | null;
}

const emptyCatalog = (): LibraryCatalog => ({
  files: [],
  directories: [],
  loaded: false,
  loading: false,
  error: "",
  truncated: false,
  collapsedFolders: new Set(),
});
const emptyView = (): LibraryView => ({
  tree: buildFileTree([]),
  query: "",
  counts: new Map(),
  selectedId: null,
  selectedPath: null,
  outsideFilter: false,
  focusRequest: null,
});

/** Own catalog identity and its immutable presentation independently of application DOM handles. */
export function createLibraryModel() {
  const [data, setData] = createStore(emptyCatalog());
  const [presentation, setPresentation] = createStore(emptyView());
  const catalog: Readonly<LibraryCatalog> = data;
  const view: Readonly<LibraryView> = presentation;
  let visible: readonly File[] = [];
  let matching: readonly File[] = [];
  const selected = (file: File) =>
    view.selectedId && file.id ? file.id === view.selectedId : file.path === view.selectedPath;
  const outside = () =>
    setPresentation("outsideFilter", Boolean(view.query.trim() && visible.some(selected) && !matching.some(selected)));

  function setCollapsed(path: string, collapsed: boolean) {
    if (catalog.collapsedFolders.has(path) === collapsed) return;
    const next = new Set(catalog.collapsedFolders);
    if (collapsed) next.add(path);
    else next.delete(path);
    setData("collapsedFolders", next);
  }

  return {
    catalog,
    view,
    reset(preserveQuery = false) {
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
    replace(files: readonly FileEntry[], directories: readonly FileEntry[], truncated: boolean) {
      batch(() => {
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
      setData(
        "files",
        catalog.files.map((file) => (file.path === path ? { ...file, title } : file)),
      );
    },
    project(files: readonly File[], directories: readonly File[], query: string) {
      visible = files;
      matching = filterNotes(files, query);
      const tree = buildFileTree(matching, query.trim() ? [] : directories);
      batch(() => {
        setPresentation("tree", reconcile(tree, { key: "path" }));
        setPresentation({ query, counts: countFileDisplays(files) });
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
