import remarkWikiLink from "remark-wiki-link";
import { headingSlug } from "./editor-helpers.ts";
import type { MarkdownConfig } from "@lezer/markdown";
import type { Processor } from "unified";

const options = { aliasDivider: "|", pageResolver: (name: string) => [name] };
export function remarkWiki(this: Processor) {
  return remarkWikiLink.call(this, options);
}

export function wikiDestination(value: string) {
  if (!value || /[:?\\\u0000-\u001f]/u.test(value)) return null;
  const [path, ...fragment] = value.trim().split("#");
  const target = path ? (/\.(md|markdown)$/i.test(path) ? path : `${path}.md`) : "";
  return target + (fragment.length ? `#${headingSlug(fragment.join("#"))}` : "");
}

export const lezerWiki: MarkdownConfig = {
  defineNodes: ["WikiLink"],
  parseInline: [
    {
      name: "WikiLink",
      before: "Link",
      parse(context, next, position) {
        if (next !== 91 || context.char(position + 1) !== 91) return -1;
        const rest = context.slice(position + 2, context.end);
        const end = rest.indexOf("]]");
        if (end < 1 || /[\r\n]/.test(rest.slice(0, end))) return -1;
        return context.addElement(context.elt("WikiLink", position, position + end + 4));
      },
    },
  ],
};
