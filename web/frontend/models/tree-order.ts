import type { FileEntry, FileTree } from "./library";

export type TreeOrder = ReadonlyMap<string, readonly string[]>;
export type Insertion = "before" | "after";
export const orderId = ({ id, path }: Pick<FileEntry, "id" | "path">) => id ?? `path:${path}`;

export function orderedChildren<File extends FileEntry>(tree: FileTree<File>, saved: readonly string[] | undefined) {
  const children: (FileTree<File> | File)[] = !tree.directories.length
    ? tree.files
    : !tree.files.length
      ? tree.directories
      : [...tree.directories, ...tree.files];
  if (!saved?.length || children.length < 2) return children;
  const remaining = new Map(children.map((entry) => [orderId(entry), entry]));
  const result: typeof children = [];
  for (const id of saved) {
    const entry = remaining.get(id);
    if (entry) {
      result.push(entry);
      remaining.delete(id);
    }
  }
  return result.concat([...remaining.values()]);
}

export function placeRelative(siblings: readonly string[], source: string, anchor: string, position: Insertion) {
  const next = siblings.filter((id) => id !== source);
  const at = next.indexOf(anchor);
  if (at === -1) return null;
  next.splice(at + Number(position === "after"), 0, source);
  return next.every((id, index) => id === siblings[index]) && next.length === siblings.length ? null : next;
}
