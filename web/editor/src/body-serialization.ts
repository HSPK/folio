import { parseBody } from "./markdown.ts";
import { normalizeSerializedBody } from "./roundtrip.ts";
import type { Node as ProseNode } from "@milkdown/prose/model";
import type { Root } from "mdast";
import type { Processor } from "unified";
import type { CachedBody, ProseNodeJSON, TextSelectionRange } from "./types/editor.ts";
import type { MarkdownNode } from "./types/markdown.ts";
import { childFragment } from "./prose-content.ts";

// Other block types can depend on document-level serialization context.
const independentBlock = (node: ProseNode) => ["paragraph", "heading", "image_block"].includes(node.type.name);

export function createBodyCache() {
  // Keep only pure parse/proof data; node weights include their source positions.
  const entries = new Map<string, { value: CachedBody; weight: number }>();
  const limit = 16 * 1024 * 1024;
  let weight = 0;
  const accepts = (source: string) => source.length <= 512 * 1024;
  const treeWeight = (tree: Root | ProseNodeJSON, nodeSize = 256) => {
    const pending: (MarkdownNode | ProseNodeJSON)[] = [tree];
    let bytes = 0;
    for (let node = pending.pop(); node; node = pending.pop()) {
      bytes += nodeSize;
      if (bytes > limit) break;
      const children = "children" in node ? node.children : "content" in node ? node.content : undefined;
      if (Array.isArray(children)) for (const child of children) pending.push(child);
    }
    return bytes;
  };
  const remove = (source: string) => {
    const entry = entries.get(source);
    if (!entry) return;
    weight -= entry.weight;
    entries.delete(source);
  };
  return {
    accepts,
    get(source: string) {
      const entry = entries.get(source);
      if (!entry) return null;
      entries.delete(source);
      entries.set(source, entry);
      return entry.value;
    },
    set(source: string, value: CachedBody) {
      remove(source);
      if (!accepts(source)) return;
      const size =
        2 * (source.length + value.serialized.length + value.model.length) +
        treeWeight(value.tree) +
        (value.serializedTree === value.tree ? 0 : treeWeight(value.serializedTree)) +
        treeWeight(value.documentJSON, 128);
      if (size > limit) return;
      entries.set(source, { value, weight: size });
      weight += size;
      while (entries.size > 4 || weight > limit) {
        const oldest = entries.keys().next();
        if (oldest.done) throw new Error("The body cache lost its oldest entry.");
        remove(oldest.value);
      }
    },
    clear() {
      entries.clear();
      weight = 0;
    },
  };
}

export function reuseParsedBody({ source, tree }: { source: string; tree: Root }) {
  return function (this: Processor) {
    const parse = this.parser;
    if (!parse) throw new Error("The Markdown parser must be configured before its body cache.");
    // Remark transforms mutate their tree; retain the original source positions.
    this.parser = (text, file) => (text === source ? structuredClone(tree) : parse.call(this, text, file));
  };
}

export function serializedBodyTree({ source, tree, serialized }: { source: string; tree: Root; serialized: string }) {
  if (source === serialized) return tree;
  const body = source.replace(/\n+$/, "");
  const end = tree.children.at(-1)?.position?.end.offset;
  // Newlines inside a literal code/HTML node must still pass the full proof.
  if (
    body === serialized.replace(/\n+$/, "") &&
    (!tree.children.length || (typeof end === "number" && Number.isInteger(end) && end <= body.length))
  )
    return tree;
  return parseBody(serialized);
}

function blockRanges(document: ProseNode, tree: Root) {
  if (tree.children.length !== document.childCount) return null;
  const ranges: TextSelectionRange[] = [];
  for (let index = 0; index < document.childCount; index += 1) {
    const block = tree.children[index];
    const type = document.child(index).type.name;
    if (independentBlock(document.child(index)) && block.type !== (type === "image_block" ? "imageBlock" : type))
      return null;
    const from = block.position?.start.offset;
    const to = block.position?.end.offset;
    if (typeof from !== "number" || typeof to !== "number" || !Number.isInteger(from) || !Number.isInteger(to))
      return null;
    ranges.push({ from, to });
  }
  return ranges;
}

export function createBodySerializer({
  document,
  source,
  tree = parseBody(source),
  serialize_fn,
}: {
  document: ProseNode;
  source: string;
  tree?: Root;
  serialize_fn: (document: ProseNode) => string;
}) {
  let previous: ProseNode;
  let current: string;
  let ranges: TextSelectionRange[] | null;
  const reset = (document: ProseNode, source: string, tree = parseBody(source)) => {
    previous = document;
    current = source;
    ranges = blockRanges(document, tree);
  };
  reset(document, source, tree);
  return {
    reset,
    serialize(next: ProseNode) {
      if (next === previous) return current;
      let from = 0;
      let endA = previous.childCount;
      let endB = next.childCount;
      while (from < Math.min(endA, endB) && previous.child(from) === next.child(from)) from += 1;
      while (endA > from && endB > from && previous.child(endA - 1) === next.child(endB - 1)) {
        endA -= 1;
        endB -= 1;
      }
      const isolated =
        ranges &&
        from < endA &&
        from < endB &&
        Array.from({ length: endA - from }, (_, index) => previous.child(from + index)).every(independentBlock) &&
        Array.from({ length: endB - from }, (_, index) => next.child(from + index)).every(independentBlock);
      if (isolated && ranges) {
        const fragment = next.copy(childFragment(next, from, endB));
        const replacement = normalizeSerializedBody(serialize_fn(fragment)).replace(/\n+$/, "");
        const local = blockRanges(fragment, parseBody(replacement));
        if (local) {
          const start = ranges[from].from;
          const end = ranges[endA - 1].to;
          const delta = replacement.length - (end - start);
          current = current.slice(0, start) + replacement + current.slice(end);
          ranges = [
            ...ranges.slice(0, from),
            ...local.map((range) => ({ from: range.from + start, to: range.to + start })),
            ...ranges.slice(endA).map((range) => ({ from: range.from + delta, to: range.to + delta })),
          ];
          previous = next;
          return current;
        }
      }
      const serialized = normalizeSerializedBody(serialize_fn(next));
      reset(next, serialized);
      return current;
    },
  };
}
