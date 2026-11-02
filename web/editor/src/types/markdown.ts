import type { Image, Literal, Root, RootContent } from "mdast";
import type { Node, Position } from "unist";

export type ImageLayout = "inline" | "left" | "center" | "right";

export interface WikiLink extends Literal {
  type: "wikiLink";
  value: string;
}

export interface ImageBlock extends Omit<Image, "type"> {
  type: "imageBlock";
  width?: string | null;
  height?: string | null;
  layout?: ImageLayout;
}

declare module "mdast" {
  interface RootContentMap {
    wikiLink: WikiLink;
    imageBlock: ImageBlock;
  }
  interface PhrasingContentMap {
    wikiLink: WikiLink;
  }
  interface BlockContentMap {
    imageBlock: ImageBlock;
  }
  interface Image {
    width?: string | null;
    height?: string | null;
    layout?: ImageLayout;
    explicitInline?: boolean;
  }
  interface Data {
    alias?: string;
    folioImageReference?: string;
    folioImageFragment?: boolean;
    folioImagesParsed?: boolean;
  }
}

export type MarkdownNode = Root | RootContent;

export function assertMarkdownRoot(node: Node): asserts node is Root {
  if (node.type !== "root" || !("children" in node) || !Array.isArray(node.children)) {
    throw new Error("The Markdown parser returned an invalid document root.");
  }
}

/** Traverse standard and extended Markdown nodes without assuming leaf nodes have children. */
export function markdownChildren(node: MarkdownNode): readonly RootContent[] {
  return "children" in node ? node.children : [];
}

export function sourceSpan(position: Position) {
  const from = position.start.offset;
  const to = position.end.offset;
  if (typeof from !== "number" || typeof to !== "number") {
    throw new Error("The Markdown parser returned a node without source offsets.");
  }
  return { from, to };
}
