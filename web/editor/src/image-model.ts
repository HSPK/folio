import { imageSchema } from "@milkdown/preset-commonmark";
import { extendListItemSchemaForTask } from "@milkdown/preset-gfm";
import { $nodeSchema, $remark } from "@milkdown/utils";
import { Fragment, Slice } from "@milkdown/prose/model";
import type { DOMOutputSpec, Node, NodeType, ResolvedPos } from "@milkdown/prose/model";
import { NodeSelection, Selection, TextSelection } from "@milkdown/prose/state";
import type { EditorState, Transaction } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import { GapCursor } from "@milkdown/prose/gapcursor";
import { closeHistory } from "@milkdown/prose/history";
import { currentViewSelection } from "./cursor-coordinates.ts";
import {
  escapeImageAttribute,
  imageAttributes,
  imageHtml,
  imageStyle,
  parseImageHtml,
  remarkImages,
} from "./image-syntax.ts";
import type { MarkdownNode } from "@milkdown/transformer";
import type { ImageLayout } from "./types/markdown.ts";
import { childFragment } from "./prose-content.ts";

export interface ImageNodeAttrs {
  src: string;
  alt: string;
  title: string;
  width: string | null;
  height: string | null;
  layout: ImageLayout;
  explicitInline: boolean;
}

export interface ImageNode extends Node {
  readonly type: NodeType & { readonly name: "image" | "image_block" };
  readonly attrs: ImageNodeAttrs;
}

export const isImageNode = (node: Node | null | undefined): node is ImageNode =>
  Boolean(node && (node.type.name === "image" || node.type.name === "image_block"));

export function imageRowCount(node: Node | null) {
  if (!node || node.type.name !== "paragraph") return 0;
  let count = 0;
  let trailingText = false;
  let leadingImages = true;
  node.forEach((child) => {
    if (isImageNode(child) && child.isInline) {
      count++;
      if (trailingText) leadingImages = false;
    } else if (child.isText) {
      if (child.text?.trim()) trailingText = true;
    } else leadingImages = false;
  });
  return leadingImages && count > 1 ? count : 0;
}

const attributes = {
  src: { default: "", validate: "string" },
  alt: { default: "", validate: "string" },
  title: { default: "", validate: "string" },
  width: { default: null, validate: "string|null" },
  height: { default: null, validate: "string|null" },
  layout: { default: "inline", validate: "string" },
  explicitInline: { default: false, validate: "boolean" },
};

function domAttributes(dom: HTMLElement) {
  const source = ["src", "alt", "title", "width", "height", "style"]
    .filter((name) => dom.hasAttribute(name))
    .map((name) => `${name}="${escapeImageAttribute(dom.getAttribute(name))}"`)
    .join(" ");
  const parsed = parseImageHtml(`<img ${source}>`);
  return parsed ? { ...parsed, title: parsed.title ?? "" } : false;
}

function markdownAttributes(node: MarkdownNode) {
  if (
    typeof node.url !== "string" ||
    (node.alt != null && typeof node.alt !== "string") ||
    (node.title != null && typeof node.title !== "string")
  )
    throw new Error("The Markdown image has invalid attributes.");
  return {
    src: node.url,
    alt: node.alt ?? "",
    title: node.title ?? "",
    ...imageAttributes({ width: node.width, height: node.height, layout: node.layout }),
    explicitInline: Boolean(node.explicitInline),
  };
}

const imageDOM = (node: Node): DOMOutputSpec => {
  if (!isImageNode(node)) throw new Error("This node is not an image.");
  return ["img", { src: node.attrs.src, alt: node.attrs.alt, title: node.attrs.title, style: imageStyle(node.attrs) }];
};

export const imagePlugins = [
  ...imageSchema.extendSchema((previous) => (ctx) => ({
    ...previous(ctx),
    attrs: attributes,
    parseDOM: [{ tag: "img[src]", getAttrs: domAttributes }],
    toDOM: imageDOM,
    parseMarkdown: {
      match: (node) => node.type === "image",
      runner: (state, node, type) => state.addNode(type, markdownAttributes(node)),
    },
    toMarkdown: {
      match: (node) => node.type.name === "image",
      runner(state, node) {
        if (!isImageNode(node)) throw new Error("This node is not an image.");
        if (node.attrs.width || node.attrs.height || node.attrs.layout !== "inline" || node.attrs.explicitInline) {
          state.addNode("html", undefined, imageHtml(node.attrs));
        } else previous(ctx).toMarkdown.runner(state, node);
      },
    },
  })),
  ...$nodeSchema("image_block", () => ({
    group: "block",
    atom: true,
    selectable: true,
    draggable: true,
    marks: "",
    attrs: { ...attributes, layout: { default: "left", validate: "string" } },
    parseDOM: [
      {
        tag: "img[src]",
        priority: 60,
        getAttrs(dom) {
          const attrs = domAttributes(dom);
          return attrs && attrs.layout !== "inline" ? attrs : false;
        },
      },
    ],
    toDOM: imageDOM,
    parseMarkdown: {
      match: (node) => node.type === "imageBlock",
      runner: (state, node, type) => state.addNode(type, markdownAttributes(node)),
    },
    toMarkdown: {
      match: (node) => node.type.name === "image_block",
      runner(state, node) {
        if (!isImageNode(node)) throw new Error("This node is not an image.");
        if (!node.attrs.width && !node.attrs.height && node.attrs.layout === "left") {
          state.openNode("paragraph");
          state.addNode("image", undefined, undefined, {
            url: node.attrs.src,
            alt: node.attrs.alt,
            title: node.attrs.title || null,
          });
          state.closeNode();
        } else state.addNode("html", undefined, imageHtml(node.attrs));
      },
    },
  })),
  ...extendListItemSchemaForTask.extendSchema((previous) => (ctx) => {
    const schema = previous(ctx);
    return {
      ...schema,
      content: "(paragraph | image_block) block*",
      toMarkdown: {
        ...schema.toMarkdown,
        runner(state, node) {
          const first = node.firstChild;
          if (
            node.childCount < 2 ||
            !first ||
            first.type.name !== "paragraph" ||
            first.content.size ||
            node.child(1).type.name !== "image_block"
          ) {
            schema.toMarkdown.runner(state, node);
            return;
          }
          // A temporarily empty line before a list image must not serialize the image outside its item.
          state.openNode("listItem", undefined, {
            spread: node.attrs.spread,
            ...(node.attrs.checked == null
              ? {}
              : {
                  label: node.attrs.label,
                  listType: node.attrs.listType,
                  checked: node.attrs.checked,
                }),
          });
          state.next(childFragment(node, 1));
          state.closeNode();
        },
      },
    };
  }),
  ...$remark("folioImageHtml", () => remarkImages),
];

export function imageBoundarySelection(document: Node, position: number, direction = 1) {
  const resolved = document.resolve(position);
  if (!hasGapValidation(GapCursor)) throw new Error("The gap cursor package does not expose its cursor validation.");
  return GapCursor.valid(resolved) ? new GapCursor(resolved) : Selection.near(resolved, direction);
}

function hasGapValidation(
  value: typeof GapCursor,
): value is typeof GapCursor & { valid(position: ResolvedPos): boolean } {
  return "valid" in value && typeof value.valid === "function";
}

function insertedImages(transaction: Transaction, start: number) {
  let from = transaction.doc.content.size;
  let to = 0;
  transaction.mapping.maps.slice(start).forEach((map, index) => {
    const remaining = transaction.mapping.slice(start + index + 1);
    map.forEach((_oldFrom, _oldTo, newFrom, newTo) => {
      from = Math.min(from, remaining.map(newFrom, -1));
      to = Math.max(to, remaining.map(newTo, 1));
    });
  });
  const images: { node: Node; position: number }[] = [];
  if (from < to)
    transaction.doc.nodesBetween(from, to, (node, position) => {
      if (isImageNode(node)) images.push({ node, position });
    });
  return images;
}

function removalRange(document: Node, position: number, { moving = false } = {}) {
  const image = document.nodeAt(position);
  if (!isImageNode(image)) throw new Error("This image is no longer available.");
  const resolved = document.resolve(position);
  if (moving && image?.isBlock && resolved.parent.type.name === "list_item" && resolved.parent.childCount === 1) {
    const depth = resolved.depth;
    const listDepth = depth - 1;
    const removedDepth = resolved.node(listDepth).childCount === 1 ? listDepth : depth;
    return { from: resolved.before(removedDepth), to: resolved.after(removedDepth) };
  }
  if (image?.isInline && resolved.parent.type.name === "paragraph" && resolved.parent.childCount === 1) {
    const depth = resolved.depth - 1;
    const index = resolved.index(depth);
    if (resolved.node(depth).canReplace(index, index + 1, Fragment.empty)) {
      return { from: resolved.before(), to: resolved.after() };
    }
  }
  return { from: position, to: position + image.nodeSize };
}

export function imageLayoutTransaction(
  state: EditorState,
  { position, attrs }: { position: number; attrs: Partial<ImageNodeAttrs> },
) {
  const image = state.doc.nodeAt(position);
  if (!isImageNode(image)) throw new Error("This image is no longer editable.");
  const next = { ...image.attrs, ...attrs };
  if (attrs.layout !== undefined && attrs.explicitInline === undefined) next.explicitInline = next.layout === "inline";
  const type =
    attrs.layout === undefined
      ? image.type
      : next.layout === "inline"
        ? state.schema.nodes.image
        : state.schema.nodes.image_block;
  const transaction = closeHistory(state.tr);
  let selected = position;
  if (type === image.type) transaction.setNodeMarkup(position, type, next);
  else if (image.isBlock) {
    const resolved = state.doc.resolve(position);
    const before = resolved.nodeBefore?.type.name === "paragraph" ? resolved.nodeBefore : null;
    const following = state.doc.nodeAt(position + image.nodeSize);
    const after = following?.type.name === "paragraph" ? following : null;
    const content = (before?.content ?? Fragment.empty)
      .append(Fragment.from(type.create(next)))
      .append(after?.content ?? Fragment.empty);
    const start = position - (before?.nodeSize ?? 0);
    const paragraph = state.schema.nodes.paragraph.create(before?.attrs ?? after?.attrs, content);
    transaction.replaceWith(start, position + image.nodeSize + (after?.nodeSize ?? 0), paragraph);
    selected = start + 1 + (before?.content.size ?? 0);
  } else {
    const resolved = state.doc.resolve(position);
    const parent = resolved.node(resolved.depth - 1);
    const index = resolved.index(resolved.depth - 1);
    const before = resolved.parent.copy(resolved.parent.content.cut(0, resolved.parentOffset));
    const after = resolved.parent.copy(resolved.parent.content.cut(resolved.parentOffset + image.nodeSize));
    const content = [
      ...(before.content.size ? [before] : []),
      type.create(next),
      ...(after.content.size ? [after] : []),
    ];
    if (!before.content.size && !parent.canReplace(index, index + 1, Fragment.from(content))) content.unshift(before);
    if (!parent.canReplace(index, index + 1, Fragment.from(content))) {
      throw new Error(
        "This location only supports inline images. Move the image into a document paragraph before changing its layout.",
      );
    }
    const start = resolved.before();
    selected = start + (content[0] === before ? before.nodeSize : 0);
    transaction.replaceWith(start, resolved.after(), content);
  }
  return transaction.setSelection(NodeSelection.create(transaction.doc, selected)).scrollIntoView();
}

export function imageRemovalTransaction(state: EditorState, position: number) {
  if (!isImageNode(state.doc.nodeAt(position))) return null;
  const { from, to } = removalRange(state.doc, position);
  return closeHistory(state.tr).delete(from, to).scrollIntoView();
}

export function imageMoveTransaction(
  state: EditorState,
  { from, to, copy = false }: { from: number; to: number; copy?: boolean },
) {
  const image = state.doc.nodeAt(from);
  if (!isImageNode(image) || !Number.isInteger(to) || to < 0 || to > state.doc.content.size) return null;
  const range = removalRange(state.doc, from, { moving: !copy });
  if (!copy && to >= range.from && to <= range.to) return null;
  const transaction = closeHistory(state.tr);
  if (!copy) transaction.delete(range.from, range.to);
  const position = transaction.mapping.map(to);
  const start = transaction.mapping.maps.length;
  transaction.replaceRangeWith(position, position, image);
  const inserted = insertedImages(transaction, start).find((item) => item.node.eq(image));
  if (!inserted) throw new Error("The image could not be moved to this position.");
  return transaction
    .setSelection(NodeSelection.create(transaction.doc, inserted.position))
    .setMeta("uiEvent", "drop")
    .scrollIntoView();
}

export function imageRowNeighbor(document: Node, position: number) {
  const image = document.nodeAt(position);
  if (!isImageNode(image) || !image.isBlock) return null;
  const resolved = document.resolve(position);
  const after = document.nodeAt(position + image.nodeSize);
  if (isImageNode(after) && after.isBlock) return { from: position, to: position + image.nodeSize, after: false };
  const before = resolved.nodeBefore;
  return isImageNode(before) && before.isBlock ? { from: position, to: position - before.nodeSize, after: true } : null;
}

export function imageRowTarget(document: Node, position: number) {
  const image = document.nodeAt(position);
  if (!isImageNode(image)) return null;
  const resolved = document.resolve(position);
  if (image.isBlock) {
    if (!resolved.parent.canReplaceWith(resolved.index(), resolved.index() + 1, document.type.schema.nodes.paragraph))
      return null;
    return { from: position, to: position + image.nodeSize, node: image, offset: 0 };
  }
  if (resolved.parent.type.name !== "paragraph") return null;
  let imagesOnly = true;
  resolved.parent.forEach((child) => {
    if (!isImageNode(child) && !(child.isText && !child.text?.trim())) imagesOnly = false;
  });
  if (!imagesOnly && !imageRowCount(resolved.parent)) return null;
  return { from: resolved.before(), to: resolved.after(), node: resolved.parent, offset: resolved.parentOffset };
}

export function imageRowTransaction(
  state: EditorState,
  { from, to, after = true, copy = false }: { from: number; to: number; after?: boolean; copy?: boolean },
) {
  const source = state.doc.nodeAt(from);
  if (from === to || !isImageNode(source) || !imageRowTarget(state.doc, to)) return null;
  const transaction = closeHistory(state.tr);
  if (!copy) {
    const range = removalRange(state.doc, from, { moving: true });
    transaction.delete(range.from, range.to);
  }
  const target = imageRowTarget(transaction.doc, transaction.mapping.map(to));
  if (!target) throw new Error("The target image is no longer available for a side-by-side layout.");
  const content = isImageNode(target.node) ? Fragment.from(target.node) : target.node.content;
  const targetImage = transaction.doc.nodeAt(transaction.mapping.map(to));
  if (!isImageNode(targetImage)) throw new Error("The target image is no longer available for a side-by-side layout.");
  const offset = target.offset + (after ? targetImage.nodeSize : 0);
  const combined = content.cut(0, offset).append(Fragment.from(source)).append(content.cut(offset));
  let count = 0;
  combined.forEach((node) => {
    if (isImageNode(node)) count++;
  });
  const width = `${Math.max(1, Math.floor(100 / count))}%`;
  const children: Node[] = [];
  combined.forEach((node) =>
    children.push(
      isImageNode(node)
        ? state.schema.nodes.image.create(
            {
              ...node.attrs,
              width,
              height: null,
              layout: "inline",
              explicitInline: true,
            },
            null,
            node.marks,
          )
        : node,
    ),
  );
  transaction.replaceWith(
    target.from,
    target.to,
    state.schema.nodes.paragraph.create(isImageNode(target.node) ? null : target.node.attrs, children),
  );
  return transaction.setSelection(NodeSelection.create(transaction.doc, target.from + 1 + offset)).scrollIntoView();
}

export function imageInsertionTransaction(
  state: EditorState,
  {
    images,
    selection = state.selection,
    block = false,
  }: {
    images: readonly Node[];
    selection?: Selection;
    block?: boolean;
  },
) {
  if (!images.length || images.some((node) => !isImageNode(node)))
    throw new Error("No insertable images were supplied.");
  const inline =
    !block &&
    images.length === 1 &&
    selection.$from.sameParent(selection.$to) &&
    selection.$from.parent.inlineContent &&
    selection.$from.parent.content.size > 0;
  const content = images.map((node) => {
    const type = inline ? state.schema.nodes.image : state.schema.nodes.image_block;
    return type.create({
      ...node.attrs,
      explicitInline: inline && node.attrs.explicitInline,
      layout: inline ? "inline" : node.attrs.layout === "inline" ? "left" : node.attrs.layout,
    });
  });
  const transaction = closeHistory(state.tr)
    .setSelection(selection)
    .replaceSelection(new Slice(Fragment.from(content), 0, 0));
  const inserted = insertedImages(transaction, 0).at(-1);
  if (!inserted) throw new Error("The image could not be inserted at the current position.");
  const end = inserted.position + inserted.node.nodeSize;
  const next = inline ? TextSelection.create(transaction.doc, end) : imageBoundarySelection(transaction.doc, end);
  return transaction.setSelection(next).setMeta("uiEvent", "paste").scrollIntoView();
}

export function createImageInsertion({
  view,
  parse_fn,
  active_fn,
  block = false,
}: {
  view: EditorView;
  parse_fn: (markdown: string) => Node;
  active_fn: () => boolean;
  block?: boolean;
}) {
  const document = view.state.doc;
  const current = currentViewSelection(view);
  const selection =
    view.state.selection instanceof TextSelection
      ? TextSelection.create(document, current.anchor, current.head)
      : view.state.selection;
  return (markdown: string) => {
    if (!active_fn() || view.state.doc !== document) return false;
    const images: ImageNode[] = [];
    let invalid = false;
    parse_fn(markdown).descendants((node) => {
      if (isImageNode(node)) images.push(node);
      else if (node.isText && node.text?.trim()) invalid = true;
    });
    if (!images.length || invalid) throw new Error("The image could not be inserted at the current position.");
    view.dispatch(imageInsertionTransaction(view.state, { images, selection, block }));
    view.focus();
    return true;
  };
}
