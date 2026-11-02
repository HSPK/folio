import { decodeHTMLStrict } from "entities";
import type { Link, Parent, Root, RootContent, Text } from "mdast";
import type { Transformer } from "unified";
import { sourceSpan } from "./types/markdown.ts";

export function autoLinkDestination(text: string) {
  if (/^https?:\/\/\S+$/i.test(text)) return text;
  if (/^www\.\S+$/i.test(text)) return `http://${text}`;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return `mailto:${text}`;
  return null;
}

export function remarkAutoLinkBoundaries(): Transformer<Root> {
  return (tree, file) => {
    const source = String(file.value ?? "");
    const visit = (parent: Parent) => {
      parent.children = parent.children.flatMap((node): RootContent[] => {
        if ("children" in node) visit(node);
        if (node.type !== "link" || !node.position) return [node];
        const original = node.position;
        const { from, to } = sourceSpan(original);
        const raw = source.slice(from, to);
        if (!/^(?:https?:\/\/|www\.)/i.test(raw) || !/[，。！？；、]/u.test(raw)) return [node];
        let consumed = 0;
        return raw
          .split(/([，。！？；、])/u)
          .filter(Boolean)
          .map((part): Link | Text => {
            const value = decodeHTMLStrict(part);
            const url = autoLinkDestination(value);
            const point = (offset: number) => ({
              line: original.start.line,
              column: original.start.column + offset,
              offset: from + offset,
            });
            const position = { start: point(consumed), end: point(consumed + part.length) };
            consumed += part.length;
            const text: Text = { type: "text", value, position };
            return url ? { type: "link", url, title: null, children: [text], position } : text;
          });
      });
      const merged: RootContent[] = [];
      for (const node of parent.children) {
        const previous = merged.at(-1);
        if (previous?.type === "text" && node.type === "text") {
          previous.value += node.value;
          if (previous.position && node.position) previous.position.end = node.position.end;
        } else merged.push(node);
      }
      parent.children = merged;
    };
    visit(tree);
  };
}
