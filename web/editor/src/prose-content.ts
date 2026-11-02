import type { Node } from "@milkdown/prose/model";

export function childFragment(node: Node, from: number, to = node.childCount) {
  let start = 0;
  let end = 0;
  for (let index = 0; index < to; index += 1) {
    const size = node.child(index).nodeSize;
    if (index < from) start += size;
    end += size;
  }
  return node.content.cut(start, end);
}
