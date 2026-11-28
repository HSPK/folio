import { parser as cpp } from "@lezer/cpp";
import { parser as js } from "@lezer/javascript";
import { parser as rust } from "@lezer/rust";
import { parser as php } from "@lezer/php";
import { highlightTree } from "@lezer/highlight";
import { TreeFragment, type Parser, type Tree, type Input, type ChangedRange } from "@lezer/common";
import { codeTokenStyle } from "./code-token-style.ts";
export { codeFileMode } from "./code-file-modes.ts";

const parsers = new Map<string, Parser>([
  ["C", cpp],
  ["C++", cpp],
  ["Rust", rust],
  ["JavaScript", js],
  ["JSX", js.configure({ dialect: "jsx" })],
  ["TypeScript", js.configure({ dialect: "ts" })],
  ["TSX", js.configure({ dialect: "ts jsx" })],
  ["PHP", php],
]);

const fileLabels: Record<string, string> = {
  c: "C",
  h: "C++",
  cpp: "C++",
  cxx: "C++",
  cc: "C++",
  hpp: "C++",
  rs: "Rust",
  js: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  jsx: "JSX",
  ts: "TypeScript",
  tsx: "TSX",
  php: "PHP",
};

// Keep parser trees, fragments and tag identities together in the lazy syntax module.
export function codeFileParser(ext: string) {
  const parser = Object.hasOwn(fileLabels, ext) && parsers.get(fileLabels[ext]);
  if (!parser) return;
  let fragments: readonly TreeFragment[] = [];
  return {
    start(input: Input, end: number) {
      const parse = parser.startParse(input, fragments);
      if (end < input.length) parse.stopAt(end);
      return parse;
    },
    changed(changes: ChangedRange[]) {
      fragments = TreeFragment.applyChanges(fragments, changes);
    },
    remember(tree: Tree, partial: boolean) {
      fragments = TreeFragment.addTree(tree, fragments, partial);
    },
    tokens(tree: Tree, from: number, to: number, emit: (from: number, to: number, cls: string) => void) {
      highlightTree(tree, codeTokenStyle, emit, from, to);
    },
  };
}

export function highlight(label: string, text: string) {
  const ranges: [number, number, string][] = [];
  const parser = parsers.get(label);
  if (parser)
    highlightTree(parser.parse(text), codeTokenStyle, (from, to, cls) => {
      if (to > from) ranges.push([from, to, cls]);
    });
  return ranges;
}
