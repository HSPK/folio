import type { Node as ProseNode } from "@milkdown/prose/model";

export function normalizeSerializedBody(source: string, document?: ProseNode) {
  if (!source.includes("<br />")) return source;
  // A literal break in user Markdown is not an empty paragraph placeholder.
  let literal = false;
  document?.descendants((node) => {
    const text: unknown = node.text ?? node.attrs.source ?? node.attrs.value;
    if (typeof text === "string" && text.includes("<br />")) literal = true;
    return !literal;
  });
  if (literal) return source;
  const withoutListPlaceholders = source
    .replace(/^([ \t]*(?:[*+-]|\d+[.)]))[ \t]+<br \/>\r?\n[ \t]+(#{1,6}[ \t]+.*)$/gm, "$1 $2")
    .replace(/^([ \t]*(?:[*+-]|\d+[.)]))[ \t]+<br \/>[ \t]*$/gm, "$1 ");
  return withoutListPlaceholders
    .split("\n")
    .map((line) => (/^\s*\|.*\|\s*$/.test(line) ? line.replace(/(^|\|)([ \t]*)<br \/>[ \t]*(?=\|)/g, "$1$2") : line))
    .join("\n");
}
