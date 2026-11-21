import type { Node as ProseNode } from "@milkdown/prose/model";
import { type Decoration, DecorationSet } from "@milkdown/prose/view";

interface SetInternals {
  local: readonly Decoration[];
  children: readonly (number | DecorationSet)[];
}

const Base = DecorationSet as unknown as new (
  local: readonly Decoration[],
  children: readonly (number | DecorationSet)[],
) => DecorationSet & SetInternals;

/**
 * A document-level decoration set whose per-block lookup is a map read. The stock set scans its child
 * list and its own decorations for every top-level block it is asked about, which grows with the square
 * of the block count: tens of milliseconds per keystroke once a note has thousands of blocks.
 * It holds only node decorations of top-level blocks itself; everything deeper lives in `children`.
 */
class IndexedDecorationSet extends Base {
  private index: Map<number, DecorationSet> | null = null;

  forChild(offset: number, node: ProseNode) {
    if (node.isLeaf) return DecorationSet.empty;
    if (!this.index) {
      this.index = new Map();
      for (let at = 0; at < this.children.length; at += 3)
        this.index.set(this.children[at] as number, this.children[at + 2] as DecorationSet);
    }
    return this.index.get(offset) ?? DecorationSet.empty;
  }
}

/**
 * Combine node decorations for top-level blocks, in document order, with a set that decorates only the
 * inside of blocks. Returns null when the inner set does not have that shape.
 */
export function indexedDecorations(topLevel: readonly Decoration[], inner: DecorationSet): DecorationSet | null {
  const parts = inner as unknown as Partial<SetInternals>;
  if (!Array.isArray(parts.children) || !Array.isArray(parts.local) || parts.local.length) return null;
  return new IndexedDecorationSet(topLevel, parts.children);
}
