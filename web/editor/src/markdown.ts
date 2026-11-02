import { GFM, parser as markdownParser } from "@lezer/markdown";
import { TreeFragment } from "@lezer/common";
import type { SyntaxNode, Tree } from "@lezer/common";
import type { Node as ProseNode } from "@milkdown/prose/model";
import type { Definition, Root, TableCell } from "mdast";
import type { ChangedRange, Heading, OutlineExtractor, SourcePosition } from "./types/editor.ts";
import { markdownChildren, type MarkdownNode } from "./types/markdown.ts";
import { decodeHTMLStrict } from "entities";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { assignHeadingIds, splitFrontMatter } from "./editor-helpers.ts";
import { remarkDisplayMath } from "./math-syntax.ts";
import { lezerWiki, remarkWiki } from "./wiki-syntax.ts";
import { imageAttributes, parseImageHtml, remarkImages } from "./image-syntax.ts";
import { remarkAutoLinkBoundaries } from "./link-syntax.ts";

const outlineParser = markdownParser.configure([GFM, lezerWiki]);
const bodyParser = unified()
  .use(remarkParse)
  .use(remarkMath)
  .use(remarkDisplayMath)
  .use(remarkGfm)
  .use(remarkAutoLinkBoundaries)
  .use(remarkWiki)
  .use(remarkImages);
const markerNames = /^(?:HeaderMark|EmphasisMark|StrikethroughMark|CodeMark|LinkMark|ListMark|QuoteMark)$/;

export function documentHeadings(document: ProseNode) {
  const headings: { node: ProseNode; position: number; text: string }[] = [];
  document.descendants((node, position) => {
    if (node.type.name !== "heading") return;
    let text = "";
    node.descendants((child) => {
      if (child.isText) text += child.text;
      else if (child.type.name === "image") text += child.attrs.alt ?? "";
      else if (child.type.name === "wiki_link") text += child.attrs.label || child.attrs.target;
      else if (child.type.name === "hardbreak") text += " ";
    });
    headings.push({ node, position, text });
  });
  const ids = assignHeadingIds(headings.map((heading) => heading.text));
  return headings.map((heading, index) => ({ ...heading, id: ids[index] }));
}

function children(node: SyntaxNode) {
  const items: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) items.push(child);
  return items;
}

function headingText(node: SyntaxNode, source: string) {
  const collect = (part: SyntaxNode, from = part.from, to = part.to): string => {
    let text = "";
    let position = from;
    for (const child of children(part)) {
      if (child.from < from || child.to > to) continue;
      text += source.slice(position, child.from);
      if (child.name === "HTMLTag") text += parseImageHtml(source.slice(child.from, child.to))?.alt ?? "";
      if (!markerNames.test(child.name) && child.name !== "HTMLTag" && child.name !== "HTMLBlock") {
        if (child.name === "WikiLink")
          text += source
            .slice(child.from + 2, child.to - 2)
            .split("|")
            .slice(-1)[0]
            .trim();
        else if (child.name === "Entity") text += decodeHTMLStrict(source.slice(child.from, child.to));
        else if (child.name === "Escape") text += source.slice(child.from + 1, child.to);
        else if (child.name === "Link" || child.name === "Image") {
          const marks = children(child).filter((mark) => mark.name === "LinkMark");
          const closing = marks.find((mark) => source.slice(mark.from, mark.to) === "]");
          text += closing ? collect(child, marks[0].to, closing.from) : source.slice(child.from, child.to);
        } else text += collect(child);
      }
      position = child.to;
    }
    return text + source.slice(position, to);
  };
  return collect(node).trim();
}

function outlineItems(tree: Tree, body: string, bodyStart: number): Heading[] {
  const items: Omit<Heading, "id">[] = [];
  const labels: string[] = [];
  tree.iterate({
    enter(reference) {
      if (!/^(?:ATX|Setext)Heading[1-6]$/.test(reference.name)) return;
      const label = headingText(reference.node, body);
      labels.push(label);
      items.push({
        text: label.replace(/\s+/g, " "),
        level: Number(reference.name.at(-1)),
        from: bodyStart + reference.from,
      });
    },
  });
  const ids = assignHeadingIds(labels);
  return items.map((item, index) => ({ ...item, id: ids[index] }));
}

export function extractOutline(source: string) {
  const parts = splitFrontMatter(source);
  return outlineItems(outlineParser.parse(parts.body), parts.body, parts.bodyStart);
}

function changedRange(previous: string, next: string) {
  const shared = Math.min(previous.length, next.length);
  let from = 0;
  while (from < shared && previous.charCodeAt(from) === next.charCodeAt(from)) from += 1;
  let toA = previous.length;
  let toB = next.length;
  while (toA > from && toB > from && previous.charCodeAt(toA - 1) === next.charCodeAt(toB - 1)) {
    toA -= 1;
    toB -= 1;
  }
  return { fromA: from, toA, fromB: from, toB };
}

function bodyChangedRanges(
  changes: readonly ChangedRange[],
  oldStart: number,
  oldLength: number,
  nextStart: number,
  nextLength: number,
) {
  const clamp = (value: number, length: number) => Math.max(0, Math.min(length, value));
  return changes
    .map((change) => ({
      fromA: clamp(change.fromA - oldStart, oldLength),
      toA: clamp(change.toA - oldStart, oldLength),
      fromB: clamp(change.fromB - nextStart, nextLength),
      toB: clamp(change.toB - nextStart, nextLength),
    }))
    .filter((change) => change.fromA !== change.toA || change.fromB !== change.toB);
}

export function createOutlineExtractor(): OutlineExtractor {
  let body: string | null = null;
  let bodyStart = -1;
  let tree: Tree | null = null;
  let items: Heading[] = [];
  return {
    extract(source, changes = null) {
      const parts = splitFrontMatter(source);
      if (parts.body === body && parts.bodyStart === bodyStart) return items;
      if (parts.body !== body || !tree) {
        const precise =
          tree &&
          body !== null &&
          changes &&
          Array.isArray(changes.ranges) &&
          changes.beforeLength === bodyStart + body.length &&
          changes.afterLength === source.length
            ? bodyChangedRanges(changes.ranges, bodyStart, body.length, parts.bodyStart, parts.body.length)
            : null;
        const fragments =
          tree && body !== null
            ? TreeFragment.applyChanges(
                TreeFragment.addTree(tree),
                precise?.length ? precise : [changedRange(body, parts.body)],
              )
            : [];
        tree = outlineParser.parse(parts.body, fragments);
        body = parts.body;
      }
      bodyStart = parts.bodyStart;
      items = outlineItems(tree, parts.body, bodyStart);
      return items;
    },
    clear() {
      body = null;
      bodyStart = -1;
      tree = null;
      items = [];
    },
  };
}

export function parseBody(source: string): Root {
  return bodyParser.runSync(bodyParser.parse(source), { value: source });
}

export function readableMarkdown(source: string) {
  const text = (node: MarkdownNode): string => {
    if (node.type === "definition" || node.type === "html") return "";
    if (node.type === "wikiLink") return node.data?.alias || node.value;
    if (node.type === "image" || node.type === "imageBlock") return node.alt || "";
    if (node.type === "break") return "\n";
    if ("value" in node && typeof node.value === "string") return node.value;
    const separator = ["root", "list", "listItem", "blockquote", "table", "tableRow"].includes(node.type) ? "\n" : "";
    return markdownChildren(node).map(text).join(separator);
  };
  return text(parseBody(source))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function unsupportedBody(tree: Root, source: string) {
  const unsupported = (node: MarkdownNode): boolean =>
    node.type.startsWith("footnote") || markdownChildren(node).some(unsupported);
  if (unsupported(tree))
    return "This body contains footnotes that formatted editing cannot safely preserve. Use Source mode; the original text is kept.";
  const wikiEmbed = (node: MarkdownNode): boolean => {
    const offset = node.position?.start.offset;
    if (node.type === "wikiLink" && typeof offset === "number" && source[offset - 1] === "!") {
      let slashes = 0;
      for (let index = offset - 2; index >= 0 && source[index] === "\\"; index -= 1) slashes += 1;
      if (slashes % 2 === 0) return true;
    }
    return markdownChildren(node).some(wikiEmbed);
  };
  if (wikiEmbed(tree))
    return "Embedded wiki images are not supported by Live editing. Use standard Markdown images or Source mode; the original text is kept.";
  const definitions: string[] = [];
  const references = new Set<string>();
  const text: string[] = [];
  const visit = (node: MarkdownNode) => {
    if (node.type === "definition") definitions.push(node.identifier);
    if (node.type === "linkReference" || node.type === "imageReference") references.add(node.identifier);
    if (node.data?.folioImageReference) references.add(node.data.folioImageReference);
    if (node.type === "text") text.push(node.value);
    markdownChildren(node).forEach(visit);
  };
  visit(tree);
  if (
    new Set(definitions).size !== definitions.length ||
    definitions.some((identifier) => !references.has(identifier))
  ) {
    return "Unused or duplicate link definitions cannot be safely preserved by formatted editing. Use Source mode; the original text is kept.";
  }
  if (text.some((value) => /^\s*:::/m.test(value))) {
    return "This body contains an unsupported Markdown extension. Use Source mode to preserve its exact syntax.";
  }
  return "";
}

export function bodyFingerprint(tree: Root) {
  const definitions = new Map<string, Definition>();
  const find = (node: MarkdownNode) => {
    if (node.type === "definition") definitions.set(node.identifier, node);
    markdownChildren(node).forEach(find);
  };
  find(tree);
  const normalize = (node: MarkdownNode): Record<string, unknown> | null => {
    if (node.type === "wikiLink")
      return { type: "wikiLink", target: node.value, label: node.data?.alias ?? node.value };
    if (node.type === "definition") return null;
    let value: MarkdownNode = node;
    if (node.type === "linkReference" || node.type === "imageReference") {
      const definition = definitions.get(node.identifier);
      if (definition)
        value =
          node.type === "linkReference"
            ? { type: "link", title: definition.title, url: definition.url, children: node.children }
            : { type: "image", title: definition.title, url: definition.url, alt: node.alt };
    }
    if (value.type === "table") {
      const table = value;
      const width = Math.max(value.align?.length ?? 0, ...value.children.map((row) => row.children?.length ?? 0));
      value = {
        ...value,
        align: Array.from({ length: width }, (_, index) => table.align?.[index] ?? null),
        children: value.children.map((row) => ({
          ...row,
          children: [
            ...row.children,
            ...Array.from({ length: width - row.children.length }, (): TableCell => ({
              type: "tableCell",
              children: [],
            })),
          ],
        })),
      };
    }
    if (value.type === "image" || value.type === "imageBlock") value = { ...value, ...imageAttributes(value) };
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .filter(
          ([key]) =>
            key !== "position" &&
            key !== "spread" &&
            key !== "data" &&
            key !== "explicitInline" &&
            !(value.type === "math" && key === "meta"),
        )
        .map(([key, entry]: [string, unknown]) => [
          key,
          key === "children" ? markdownChildren(value).map(normalize).filter(Boolean) : entry,
        ]),
    );
  };
  return JSON.stringify(normalize(tree));
}

export function sourcePositionMap(tree: Root, source: string, document: ProseNode) {
  const sourceCharacters: { char: string; source: number }[] = [];
  const append = (value: string, from: number, to: number) => {
    let cursor = from;
    for (let index = 0; index < value.length; index++) {
      const found = source.indexOf(value[index], cursor);
      const position = found >= cursor && found < to ? found : Math.min(cursor, Math.max(from, to - 1));
      sourceCharacters.push({ char: value[index], source: position });
      cursor = position + 1;
    }
  };
  const visit = (node: MarkdownNode) => {
    const from = node.position?.start.offset ?? 0;
    const to = node.position?.end.offset ?? from;
    if (node.type === "text") append(node.value, from, to);
    else if (node.type === "inlineMath" || node.type === "math") {
      sourceCharacters.push({ char: "\uFFFC", source: from });
      const opening = source.slice(from, to).match(/^\$+/)?.[0].length ?? 1;
      append(node.value, from + opening, to);
      const end = node.value.length ? sourceCharacters[sourceCharacters.length - 1].source + 1 : from + opening;
      sourceCharacters.push({ char: "\uFFF9", source: end });
    } else if (node.type === "inlineCode")
      append(node.value, from + (source.slice(from).match(/^`+/)?.[0].length ?? 0), to);
    else if (node.type === "code") {
      const fenced = /^ {0,3}(?:`{3,}|~{3,})/.test(source.slice(from, to));
      const start = fenced ? source.indexOf("\n", from) + 1 : from;
      append(node.value, start, to);
    } else if (["image", "imageBlock", "imageReference", "thematicBreak", "wikiLink"].includes(node.type)) {
      sourceCharacters.push({ char: "\uFFFC", source: from });
      sourceCharacters.push({ char: "\uFFFB", source: to });
    } else if (node.type === "break") {
      sourceCharacters.push({ char: "\n", source: from });
    } else markdownChildren(node).forEach(visit);
  };
  visit(tree);
  const editorCharacters: { char: string; position: number }[] = [];
  document.descendants((node, position) => {
    if (node.isText && typeof node.text === "string")
      for (let index = 0; index < node.text.length; index++)
        editorCharacters.push({ char: node.text[index], position: position + index });
    else if (["math_inline", "math_block"].includes(node.type.name)) {
      editorCharacters.push({ char: "\uFFFC", position });
      for (let index = 0; index < node.textContent.length; index += 1) {
        editorCharacters.push({ char: node.textContent[index], position: position + 1 + index });
      }
      editorCharacters.push({ char: "\uFFF9", position: position + 1 + node.content.size });
      return false;
    } else if (["image", "image_block", "hr", "wiki_link"].includes(node.type.name)) {
      editorCharacters.push({ char: "\uFFFC", position });
      editorCharacters.push({ char: "\uFFFB", position: position + node.nodeSize });
    } else if (node.type.name === "hardbreak") editorCharacters.push({ char: "\n", position });
  });
  const result: SourcePosition[] = [];
  let sourceIndex = 0;
  for (const editor of editorCharacters) {
    if (!sourceCharacters[sourceIndex]) break;
    if (editor.char === "\r" && sourceCharacters[sourceIndex].char === "\n") {
      result.push({ source: Math.max(0, sourceCharacters[sourceIndex].source - 1), position: editor.position });
      continue;
    }
    if (sourceCharacters[sourceIndex].char !== editor.char) {
      const found =
        /\s/.test(sourceCharacters[sourceIndex].char) && /\s/.test(editor.char)
          ? 0
          : sourceCharacters.slice(sourceIndex, sourceIndex + 32).findIndex((item) => item.char === editor.char);
      if (found >= 0) sourceIndex += found;
    }
    result.push({ source: sourceCharacters[sourceIndex].source, position: editor.position });
    sourceIndex++;
  }
  return result;
}

function firstAtOrAfter(map: readonly SourcePosition[], key: keyof SourcePosition, value: number) {
  let from = 0;
  let to = map.length;
  while (from < to) {
    const middle = (from + to) >>> 1;
    if (map[middle][key] < value) from = middle + 1;
    else to = middle;
  }
  return from < map.length ? from : -1;
}

export function sourceOffset(map: readonly SourcePosition[], position: number) {
  const index = firstAtOrAfter(map, "position", position);
  if (index < 0) return (map.at(-1)?.source ?? -1) + 1;
  const next = map[index];
  return next.position === position || index === 0 ? next.source : map[index - 1].source + 1;
}

export function documentOffset(map: readonly SourcePosition[], source: number) {
  const index = firstAtOrAfter(map, "source", source);
  if (index < 0) return (map.at(-1)?.position ?? -1) + 1;
  const next = map[index];
  if (index === 0 || source !== map[index - 1].source + 1) return next.position;
  return map[index - 1].position + 1;
}
