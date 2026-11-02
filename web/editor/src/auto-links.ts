import { linkSchema } from "@milkdown/preset-commonmark";
import { Plugin, type EditorState } from "@milkdown/prose/state";
import type { Node as ProseNode } from "@milkdown/prose/model";
import { $prose, $remark } from "@milkdown/utils";
import { parseBody } from "./markdown.ts";
import { autoLinkDestination, remarkAutoLinkBoundaries } from "./link-syntax.ts";
export { autoLinkDestination } from "./link-syntax.ts";
import { markdownChildren, type MarkdownNode } from "./types/markdown.ts";
import type { TextSelectionRange } from "./types/editor.ts";

interface AutoLink extends TextSelectionRange {
  href: string;
}

export function findAutoLinks(text: string): AutoLink[] {
  if (!/(?:https?:\/\/|www\.|@)/i.test(text)) return [];
  const links: AutoLink[] = [];
  const visit = (node: MarkdownNode) => {
    if (node.type === "link") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (typeof start !== "number" || typeof end !== "number")
        throw new Error("An automatic link lost its source position.");
      const from = start - 2;
      const to = end - 2;
      const value = text.slice(from, to);
      const href = autoLinkDestination(value);
      if (href && node.url === href) links.push({ from, to, href });
      return;
    }
    if (["code", "inlineCode", "html", "image", "imageBlock"].includes(node.type)) return;
    markdownChildren(node).forEach(visit);
  };
  // The text already belongs to a ProseMirror paragraph, not a Markdown code block.
  visit(parseBody(`x ${text}`));
  return links;
}

export function autoLinkTransaction(oldState: EditorState, state: EditorState) {
  const from = oldState.doc.content.findDiffStart(state.doc.content);
  if (from === null) return null;
  const end = oldState.doc.content.findDiffEnd(state.doc.content);
  const to = Math.max(from, end?.b ?? from);
  const blocks = new Map<number, ProseNode>();
  for (const point of [from, to]) {
    const resolved = state.doc.resolve(point);
    if (resolved.parent.isTextblock) blocks.set(resolved.start(), resolved.parent);
  }
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.isTextblock) {
      blocks.set(pos + 1, node);
      return false;
    }
    return true;
  });
  const mark = state.schema.marks.link;
  if (!mark) return null;
  const tr = state.tr;
  for (const [start, block] of blocks) {
    if (block.type.spec.code) continue;
    const excluded: TextSelectionRange[] = [];
    const existing: AutoLink[] = [];
    let text = "";
    block.forEach((node, offset) => {
      text += node.isText ? node.text : " ".repeat(node.nodeSize);
      const link = mark.isInSet(node.marks);
      const range = { from: offset, to: offset + node.nodeSize };
      if (!node.isText || node.marks.some((mark) => mark.type.name === "inlineCode") || (link && !link.attrs.auto))
        excluded.push(range);
      if (link?.attrs.auto) {
        const previous = existing.at(-1);
        if (previous?.to === range.from && previous.href === link.attrs.href) previous.to = range.to;
        else existing.push({ ...range, href: link.attrs.href });
      }
    });
    const desired = findAutoLinks(text).filter(
      (link) => !excluded.some((range) => range.from < link.to && range.to > link.from),
    );
    if (JSON.stringify(existing) === JSON.stringify(desired)) continue;
    for (const link of existing) tr.removeMark(start + link.from, start + link.to, mark);
    for (const link of desired)
      tr.addMark(start + link.from, start + link.to, mark.create({ href: link.href, auto: true }));
  }
  return tr.steps.length ? tr : null;
}

export const autoLinks = [
  $remark("folioAutoLinkBoundaries", () => remarkAutoLinkBoundaries),
  linkSchema.extendSchema((previous) => (ctx) => {
    const spec = previous(ctx);
    return {
      ...spec,
      inclusive: false,
      attrs: { ...spec.attrs, auto: { default: false } },
      parseMarkdown: {
        ...spec.parseMarkdown,
        runner(state, node, type) {
          const label = node.children?.every((child) => child.type === "text")
            ? node.children.map((child) => child.value).join("")
            : "";
          state.openMark(type, {
            href: node.url,
            title: node.title ?? null,
            auto: !node.title && autoLinkDestination(label) === node.url,
          });
          state.next(node.children);
          state.closeMark(type);
        },
      },
    };
  }),
  $prose(() => {
    let composing = false;
    let compositionStart: EditorState | null = null;
    return new Plugin({
      props: {
        handleDOMEvents: {
          compositionstart(view) {
            composing = true;
            compositionStart = view.state;
            return false;
          },
          compositionend(view) {
            composing = false;
            queueMicrotask(() => {
              if (!view.isDestroyed && compositionStart) {
                const tr = autoLinkTransaction(compositionStart, view.state);
                compositionStart = null;
                if (tr) view.dispatch(tr);
              }
            });
            return false;
          },
        },
      },
      appendTransaction(transactions, before, state) {
        if (
          composing ||
          !transactions.some((tr) => tr.docChanged) ||
          transactions.some((tr) => tr.getMeta("folio-link-edit"))
        )
          return;
        return autoLinkTransaction(before, state);
      },
    });
  }),
].flat();
