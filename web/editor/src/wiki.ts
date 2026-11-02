import { $inputRule, $nodeSchema, $remark } from "@milkdown/utils";
import { InputRule } from "@milkdown/prose/inputrules";
import { resolveMarkdownUrl } from "./editor-helpers.ts";
import { remarkWiki, wikiDestination } from "./wiki-syntax.ts";
import type { NodeViewConstructor } from "@milkdown/prose/view";
import type { Node as ProseNode } from "@milkdown/prose/model";
import type { MarkdownUrl } from "./types/editor.ts";

export const wikiRemark = $remark("notesWikiLinks", () => remarkWiki);

export const wikiSchema = $nodeSchema("wiki_link", () => ({
  inline: true,
  group: "inline",
  atom: true,
  selectable: true,
  marks: "",
  attrs: { target: { default: "" }, label: { default: "" } },
  parseDOM: [
    {
      tag: "a[data-wiki-target]",
      getAttrs: (dom) => ({
        target: dom.getAttribute("data-wiki-target"),
        label: dom.textContent,
      }),
    },
  ],
  toDOM: (node) => ["a", { "data-wiki-target": node.attrs.target }, node.attrs.label || node.attrs.target],
  parseMarkdown: {
    match: (node) => node.type === "wikiLink",
    runner: (state, node, type) => {
      if (typeof node.value !== "string") throw new Error("A wiki link is missing its target.");
      const alias = node.data && "alias" in node.data ? node.data.alias : undefined;
      state.addNode(type, { target: node.value, label: typeof alias === "string" ? alias : node.value });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "wiki_link",
    runner: (state, node) =>
      state.addNode("wikiLink", undefined, node.attrs.target, {
        data: { alias: node.attrs.label || node.attrs.target },
      }),
  },
}));

export const wikiInputRule = $inputRule(
  (ctx) =>
    new InputRule(/\[\[([^\]\n]+)\]\]$/, (state, match, start, end) => {
      const [target, ...alias] = match[1].split("|");
      return state.tr.replaceWith(
        start,
        end,
        wikiSchema.type(ctx).create({ target: target.trim(), label: alias.join("|").trim() || target.trim() }),
      );
    }),
);

export function wikiNodeView(path: string, transformUrl: MarkdownUrl): NodeViewConstructor {
  return (initial) => {
    const dom = document.createElement("a");
    dom.className = "folio-wiki-link";
    const update = (node: ProseNode) => {
      const destination = wikiDestination(node.attrs.target);
      const target = destination === null ? null : resolveMarkdownUrl(destination, path);
      if (target) dom.dataset.noteUrl = target;
      else delete dom.dataset.noteUrl;
      const href = target ? transformUrl(target, path) : null;
      dom.dataset.wikiTarget = node.attrs.target;
      dom.textContent = node.attrs.label || node.attrs.target;
      if (href) dom.setAttribute("href", href);
      else dom.removeAttribute("href");
      dom.title = href ? "Ctrl+click (Cmd+click on Mac) to open this note" : "Unsafe wiki link disabled";
    };
    update(initial);
    return {
      dom,
      update(node) {
        if (node.type !== initial.type) return false;
        update(node);
        return true;
      },
    };
  };
}

export const wiki = [wikiRemark, wikiSchema, wikiInputRule].flat();
