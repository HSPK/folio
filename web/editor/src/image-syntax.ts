import type { BlockContent, Definition, Image, Parent, PhrasingContent, Root, RootContent } from "mdast";
import type { Processor, Transformer } from "unified";
import type { Position } from "unist";
import {
  assertMarkdownRoot,
  markdownChildren,
  sourceSpan,
  type ImageLayout,
  type MarkdownNode,
} from "./types/markdown.ts";

const entities: Record<string, string> = {
  amp: "&",
  quot: '"',
  lt: "<",
  gt: ">",
  "#39": "'",
  "#9": "\t",
  "#10": "\n",
  "#13": "\r",
};
const escapes: Record<string, string> = {
  "&": "&amp;",
  '"': "&quot;",
  "<": "&lt;",
  ">": "&gt;",
  "'": "&#39;",
  "\t": "&#9;",
  "\n": "&#10;",
  "\r": "&#13;",
};

export interface ImageAttributesInput {
  width?: unknown;
  height?: unknown;
  layout?: unknown;
  explicitInline?: boolean;
}

export interface ImageHtmlInput extends ImageAttributesInput {
  src: string;
  alt?: string | null;
  title?: string | null;
}

export interface ParsedImage {
  src: string;
  alt: string;
  title: string | null;
  width: string | null;
  height: string | null;
  layout: ImageLayout;
  explicitInline?: boolean;
}

interface ImageHtmlSpan {
  from: number;
  to: number;
  raw: string;
  image: ParsedImage;
}

interface ImageReplacement extends ImageHtmlSpan {
  token: string;
  placeholder: string;
  fromB: number;
  toB: number;
}

export function imageDimension(value: unknown) {
  if (value == null || value === "" || value === "auto") return null;
  const match = String(value)
    .trim()
    .match(/^([1-9]\d{0,4})(px|%)?$/);
  if (!match || Number(match[1]) > (match[2] === "%" ? 100 : 16384)) {
    throw new RangeError("Image sizes must be 1-16384 pixels or 1-100%.");
  }
  return `${Number(match[1])}${match[2] === "%" ? "%" : ""}`;
}

export function imageAttributes(value: ImageAttributesInput): {
  width: string | null;
  height: string | null;
  layout: ImageLayout;
} {
  const layout = value.layout ?? "inline";
  if (layout !== "inline" && layout !== "left" && layout !== "center" && layout !== "right") {
    throw new RangeError("Choose an inline, left, center, or right image layout.");
  }
  return { width: imageDimension(value.width), height: imageDimension(value.height), layout };
}

export function imageStyle(value: ImageAttributesInput) {
  const { width, height, layout } = imageAttributes(value);
  const size = (value: string) => (value.endsWith("%") ? value : `${value}px`);
  return [
    width && `width:${size(width)}`,
    height && `height:${size(height)}`,
    layout === "inline" && value.explicitInline && "display:inline",
    layout !== "inline" && "display:block",
    layout !== "inline" && `margin-left:${layout === "left" ? "0" : "auto"}`,
    layout !== "inline" && `margin-right:${layout === "right" ? "0" : "auto"}`,
  ]
    .filter(Boolean)
    .join(";");
}

export function escapeImageAttribute(value: unknown) {
  return String(value).replace(/[&"<>'\t\n\r]/g, (character) => escapes[character]);
}

export function imageHtml(value: ImageHtmlInput) {
  const attrs: Record<string, string> = {
    src: value.src,
    alt: value.alt ?? "",
    ...(value.title ? { title: value.title } : {}),
  };
  const style = imageStyle(value);
  if (style) attrs.style = style;
  return `<img ${Object.entries(attrs)
    .map(([name, value]) => `${name}="${escapeImageAttribute(value)}"`)
    .join(" ")}>`;
}

export function parseImageHtml(source: string): ParsedImage | null {
  const tag = source.trim().match(/^<img\b([\s\S]*?)\s*\/?>$/i);
  if (!tag) return null;
  const attributes = new Map<string, string>();
  const attribute = /[ \t\r\n\f]+([a-z][a-z0-9-]*)[ \t\r\n\f]*=[ \t\r\n\f]*(?:"([^"]*)"|'([^']*)')/iy;
  let offset = 0;
  while (offset < tag[1].length) {
    if (!tag[1].slice(offset).trim()) break;
    attribute.lastIndex = offset;
    const match = attribute.exec(tag[1]);
    if (!match) return null;
    const name = match[1].toLowerCase();
    const raw = match[2] ?? match[3];
    if (
      !["src", "alt", "title", "width", "height", "style"].includes(name) ||
      attributes.has(name) ||
      /&(?!(?:amp|quot|lt|gt|#39|#9|#10|#13);)/.test(raw)
    )
      return null;
    attributes.set(
      name,
      raw.replace(/&(amp|quot|lt|gt|#39|#9|#10|#13);/g, (_, name: string) => entities[name]),
    );
    offset = attribute.lastIndex;
  }
  const src = attributes.get("src");
  if (src === undefined) return null;
  const style = new Map<string, string>();
  for (const declaration of (attributes.get("style") ?? "").split(";").filter((value) => value.trim())) {
    const [name, ...rest] = declaration.split(":");
    const key = name.trim().toLowerCase();
    if (!["width", "height", "display", "margin-left", "margin-right"].includes(key) || style.has(key)) return null;
    style.set(key, rest.join(":").trim());
  }
  let layout: ImageLayout = "inline";
  const explicitInline = style.get("display") === "inline";
  if (explicitInline) {
    if (style.has("margin-left") || style.has("margin-right")) return null;
  } else if (style.has("display") || style.has("margin-left") || style.has("margin-right")) {
    if (style.get("display") !== "block") return null;
    const margins = `${style.get("margin-left")}/${style.get("margin-right")}`;
    if (margins === "0/auto") layout = "left";
    else if (margins === "auto/auto") layout = "center";
    else if (margins === "auto/0") layout = "right";
    else return null;
  }
  try {
    const width = imageDimension(style.get("width") ?? attributes.get("width"));
    const height = imageDimension(style.get("height") ?? attributes.get("height"));
    if (
      (attributes.has("width") && style.has("width") && imageDimension(attributes.get("width")) !== width) ||
      (attributes.has("height") && style.has("height") && imageDimension(attributes.get("height")) !== height)
    )
      return null;
    return {
      src,
      alt: attributes.get("alt") ?? "",
      title: attributes.get("title") ?? null,
      width,
      height,
      layout,
      ...(explicitInline ? { explicitInline: true } : {}),
    };
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return null;
  }
}

export function imageHtmlSpans(source: string) {
  const result: ImageHtmlSpan[] = [];
  const lower = source.replace(/[A-Z]/g, (character) => character.toLowerCase());
  let cursor = 0;
  while ((cursor = source.indexOf("<", cursor)) >= 0) {
    if (source.startsWith("<!--", cursor)) {
      const end = source.indexOf("-->", cursor + 4);
      cursor = end < 0 ? source.length : end + 3;
      continue;
    }
    const start = cursor;
    let quote = "";
    let end = cursor + 1;
    for (; end < source.length; end++) {
      const character = source[end];
      if (quote) {
        if (character === quote) quote = "";
      } else if (character === "'" || character === '"') quote = character;
      else if (character === ">") break;
    }
    if (end === source.length) break;
    cursor = end + 1;
    const raw = source.slice(start, cursor);
    const image = parseImageHtml(raw);
    if (image) {
      result.push({ from: start, to: cursor, raw, image });
      continue;
    }
    const opening = raw.match(/^<([a-z][a-z0-9-]*)\b/i)?.[1].toLowerCase();
    if (opening && !["img", "br", "hr", "input", "source", "wbr"].includes(opening) && !raw.endsWith("/>")) {
      const closing = lower.indexOf(`</${opening}`, cursor);
      const tail = closing < 0 ? -1 : source.indexOf(">", closing);
      cursor = tail < 0 ? source.length : tail + 1;
    }
  }
  return result;
}

function imageFragment(processor: Processor, source: string, position: Position) {
  const fragments = imageHtmlSpans(source);
  if (!fragments.length) return null;
  const spans: ImageReplacement[] = [];
  const origin = sourceSpan(position);
  const occupied = new Set([...source.matchAll(/folio-image-(\d+)-/g)].map((match) => Number(match[1])));
  let seed = 0;
  while (occupied.has(seed)) seed++;
  const prefix = `folio-image-${seed}-`;
  let processed = "";
  let end = 0;
  for (const [index, span] of fragments.entries()) {
    processed += source.slice(end, span.from);
    const token = `${prefix}${index}`;
    const placeholder = `![](${token})`;
    const fromB = processed.length;
    processed += placeholder;
    spans.push({ ...span, token, placeholder, fromB, toB: processed.length });
    end = span.to;
  }
  processed += source.slice(end);
  const tree = processor.runSync(processor.parse(processed), { value: processed, data: { folioImageFragment: true } });
  assertMarkdownRoot(tree);
  const byToken = new Map(spans.map((span) => [span.token, span.image]));
  const literal = new RegExp(`!\\[\\]\\(${prefix}(\\d+)\\)`, "g");
  const original = (offset: number, ending: boolean) => {
    let low = 0;
    let high = spans.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (spans[middle].toB <= offset) low = middle + 1;
      else high = middle;
    }
    const span = spans[low];
    if (span && offset >= span.fromB) return offset === span.fromB || !ending ? span.from : span.to;
    return low ? offset - spans[low - 1].toB + spans[low - 1].to : offset;
  };
  const lines = [0, ...[...source.matchAll(/\r\n|\r|\n/g)].map((match) => match.index + match[0].length)];
  const point = (offset: number) => {
    let low = 0;
    let high = lines.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (lines[middle] <= offset) low = middle + 1;
      else high = middle;
    }
    const line = Math.max(0, low - 1);
    return {
      offset: origin.from + offset,
      line: position.start.line + line,
      column: offset - lines[line] + (line ? 1 : position.start.column),
    };
  };
  const restore = (node: MarkdownNode) => {
    const image = node.type === "image" && byToken.get(node.url);
    if (image)
      Object.assign(node, {
        url: image.src,
        alt: image.alt,
        title: image.title,
        ...imageAttributes(image),
        ...(image.explicitInline ? { explicitInline: true } : {}),
      });
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === "string" && value.includes(prefix)) {
        Object.assign(node, {
          [key]: value.replace(literal, (match, index: string) => spans[Number(index)]?.raw ?? match),
        });
      }
    }
    if (node.position) {
      const { from, to } = sourceSpan(node.position);
      node.position = { start: point(original(from, false)), end: point(original(to, true)) };
    }
    markdownChildren(node).forEach(restore);
  };
  restore(tree);
  return tree.children;
}

export function remarkImages(this: Processor): Transformer<Root> {
  const processor = this;
  return (tree, file) => {
    const source = String(file.value ?? "");
    if (tree.data?.folioImagesParsed || !/!\[|<img\b/i.test(source)) return;
    const definitions = new Map<string, Definition>();
    if (source.includes("]:")) {
      const collect = (node: MarkdownNode) => {
        if (node.type === "definition") definitions.set(node.identifier, node);
        markdownChildren(node).forEach(collect);
      };
      collect(tree);
    }
    const visit = (parent: Parent) => {
      parent.children = parent.children.flatMap((node): RootContent[] => {
        if (node.type === "imageReference") {
          const definition = definitions.get(node.identifier);
          if (definition)
            return [
              {
                type: "image",
                url: definition.url,
                alt: node.alt,
                title: definition.title ?? null,
                position: node.position,
                data: { ...node.data, folioImageReference: node.identifier },
              },
            ];
        }
        if (node.type !== "html") {
          if ("children" in node) visit(node);
          return [node];
        }
        const image = parseImageHtml(node.value);
        if (!image) {
          if (!node.position || !/<img\b/i.test(node.value)) return [node];
          const { from, to } = sourceSpan(node.position);
          const raw = String(file.value).slice(from, to);
          // A leading HTML image makes CommonMark treat the rest of its paragraph as raw HTML.
          const fragment = imageFragment(processor, raw, node.position);
          if (!fragment) return [node];
          return ["paragraph", "heading", "tableCell"].includes(parent.type)
            ? fragment.length === 1 && fragment[0].type === "paragraph"
              ? fragment[0].children
              : [node]
            : fragment;
        }
        const child: Image = {
          type: "image",
          url: image.src,
          alt: image.alt,
          title: image.title,
          ...imageAttributes(image),
          ...(image.explicitInline ? { explicitInline: true } : {}),
          position: node.position,
        };
        return [
          ["paragraph", "heading", "tableCell"].includes(parent.type)
            ? child
            : { type: "paragraph", children: [child], position: node.position },
        ];
      });
    };
    visit(tree);
    if (!file.data?.folioImageFragment) splitBlockImages(tree);
    tree.data = { ...tree.data, folioImagesParsed: true };
  };
}

function splitBlockImages(parent: Parent) {
  parent.children = parent.children.flatMap((node): RootContent[] => {
    if (node.type !== "paragraph") {
      if ("children" in node) splitBlockImages(node);
      return [node];
    }
    const standalone = node.children.every(
      (child) => child.type === "image" || (child.type === "text" && !child.value.trim()) || child.type === "break",
    );
    const images = standalone ? node.children.filter((child) => child.type === "image") : [];
    const row =
      images.length > 1 &&
      images.every((child) => (child.layout ?? "inline") === "inline") &&
      (images.every((child) => child.explicitInline) ||
        !node.children.some(
          (child) => child.type === "break" || (child.type === "text" && /[\r\n]/.test(child.value)),
        ));
    if (row) return [{ ...node, children: images }];
    const block = (child: RootContent) =>
      child.type === "image" && ((child.layout ?? "inline") !== "inline" || (standalone && !child.explicitInline));
    if (!node.children.some(block)) {
      splitBlockImages(node);
      return [node];
    }
    const result: BlockContent[] = [];
    let children: PhrasingContent[] = [];
    const flush = () => {
      if (!children.length) return;
      const first = children[0].position;
      const last = children[children.length - 1].position;
      if (!first || !last) throw new Error("An image paragraph lost its source position.");
      result.push({
        type: "paragraph",
        children,
        position: {
          start: first.start,
          end: last.end,
        },
      });
      children = [];
    };
    for (const child of node.children) {
      if (child.type === "image" && block(child)) {
        flush();
        result.push({
          ...child,
          type: "imageBlock",
          layout: (child.layout ?? "inline") === "inline" ? "left" : child.layout,
        });
      } else if (!standalone || child.type === "image") children.push(child);
    }
    flush();
    return result;
  });
}
