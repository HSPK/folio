import type { Parent, Root, RootContent } from "mdast";
import type { VFile } from "vfile";
import { sourceSpan } from "./types/markdown.ts";

export function remarkDisplayMath() {
  return (tree: Root, file: VFile) => {
    const source = String(file.value ?? "");
    const transform = (parent: Parent) => {
      parent.children = parent.children.map((node): RootContent => {
        if (
          node.type === "paragraph" &&
          node.children?.length === 1 &&
          node.children[0].type === "inlineMath" &&
          node.position
        ) {
          const { from, to } = sourceSpan(node.position);
          const raw = source.slice(from, to).trim();
          if (raw.startsWith("$$") && raw.endsWith("$$") && raw.length >= 4) {
            return { type: "math", value: raw.slice(2, -2), position: node.position };
          }
        }
        if ("children" in node) transform(node);
        return node;
      });
    };
    transform(tree);
  };
}
