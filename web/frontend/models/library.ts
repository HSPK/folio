import { normalizeNotePath } from "./paths";

export interface FileEntry {
  path: string;
  name: string;
  title?: string | null;
  id?: string;
}

export interface FileTree<File extends FileEntry = FileEntry> {
  name: string;
  title: string | null;
  path: string;
  directories: FileTree<File>[];
  files: File[];
}

export function fileLabel(file: FileEntry) {
  return file.title ?? (file.name.replace(/\.(?:md|markdown)$/i, "") || file.name);
}

export function fileDisplayKey(file: FileEntry) {
  return fileLabel(file).normalize("NFC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

export function countFileDisplays(files: readonly FileEntry[]) {
  const counts = new Map<string, number>();
  for (const file of files) {
    const key = fileDisplayKey(file);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

interface SearchableFile {
  path: string;
  name: string;
  title?: string | null;
  normalizedPath: string;
  normalizedName: string;
  normalizedTitle: string;
}
const noteSearchCache = new WeakMap<FileEntry, SearchableFile>();

export function filterNotes<File extends FileEntry>(files: File[], query: string): File[];
export function filterNotes<File extends FileEntry>(files: readonly File[], query: string): readonly File[];
export function filterNotes<File extends FileEntry>(files: readonly File[], query: string) {
  const needle = normalizeNotePath(query.trim()).toLowerCase();
  if (!needle) return files;
  return files.filter((file) => {
    let searchable = noteSearchCache.get(file);
    if (
      !searchable ||
      searchable.path !== file.path ||
      searchable.name !== file.name ||
      searchable.title !== file.title
    ) {
      searchable = {
        path: file.path,
        name: file.name,
        title: file.title,
        normalizedPath: file.path.toLowerCase(),
        normalizedName: file.name.toLowerCase(),
        normalizedTitle: file.title?.toLowerCase() ?? "",
      };
      noteSearchCache.set(file, searchable);
    }
    return (
      searchable.normalizedPath.includes(needle) ||
      searchable.normalizedName.includes(needle) ||
      searchable.normalizedTitle.includes(needle)
    );
  });
}

export function sameTreeStructure(left: readonly FileEntry[], right: readonly FileEntry[]) {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const other = right[index];
      return (
        other && (entry.id ?? null) === (other.id ?? null) && entry.path === other.path && entry.name === other.name
      );
    })
  );
}

export function sameTreeEntries(left: readonly FileEntry[], right: readonly FileEntry[]) {
  return (
    sameTreeStructure(left, right) &&
    left.every((entry, index) => (entry.title ?? null) === (right[index].title ?? null))
  );
}

interface Branch<File extends FileEntry> {
  name: string;
  title: string | null;
  path: string;
  directories: Map<string, Branch<File>>;
  files: File[];
}
const treeCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function buildFileTree<File extends FileEntry>(
  files: readonly File[],
  directories: readonly FileEntry[] = [],
): FileTree<File> {
  const root: Branch<File> = { name: "", title: null, path: "", directories: new Map(), files: [] };
  const ensureChild = (parent: Branch<File>, name: string) => {
    let child = parent.directories.get(name);
    if (!child) {
      child = {
        name,
        title: null,
        path: parent.path ? `${parent.path}/${name}` : name,
        directories: new Map(),
        files: [],
      };
      parent.directories.set(name, child);
    }
    return child;
  };
  const ensurePath = (path: string, includeLeaf: boolean) => {
    const normalized = normalizeNotePath(path);
    let parent = root;
    let start = 0;
    while (start < normalized.length) {
      const slash = normalized.indexOf("/", start);
      if (slash < 0) return includeLeaf ? ensureChild(parent, normalized.slice(start)) : parent;
      parent = ensureChild(parent, normalized.slice(start, slash));
      start = slash + 1;
    }
    return parent;
  };
  for (const directory of directories) {
    const branch = ensurePath(directory.path, true);
    if (directory.title) branch.title = directory.title;
  }
  for (const file of files) ensurePath(file.path, false).files.push(file);
  const compare = (a: Pick<FileEntry, "name" | "title">, b: Pick<FileEntry, "name" | "title">) =>
    treeCollator.compare(a.title ?? a.name, b.title ?? b.name);
  const finish = (branch: Branch<File>): FileTree<File> => ({
    name: branch.name,
    title: branch.title,
    path: branch.path,
    directories: [...branch.directories.values()].sort(compare).map(finish),
    files: [...branch.files].sort(compare),
  });
  return finish(root);
}
