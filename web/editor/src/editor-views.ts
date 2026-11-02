import type { Ctx } from "@milkdown/ctx";
import type { Node as ProseNode } from "@milkdown/prose/model";
import { Decoration, DecorationSet, type EditorProps } from "@milkdown/prose/view";
import { createMathNodeViews } from "./math.ts";
import { wikiNodeView } from "./wiki.ts";
import { codeBlockDecorations, codeBlockNodeView } from "./code-block.ts";
import { linkMarkView } from "./links.ts";
import type { createImageTools } from "./images.ts";
import type { createTableTools } from "./tables.ts";
import type { documentHeadings } from "./markdown.ts";
import type { DeferredScrollbars, InlineEditorOptions, MarkdownUrl, NodeActivity } from "./types/editor.ts";

interface EditorViewsOptions extends NodeActivity {
  ctx: Ctx;
  path: string;
  transformUrl: MarkdownUrl;
  readOnly_fn: () => boolean;
  onNotice?: InlineEditorOptions["onNotice"];
  scrollbars: DeferredScrollbars;
  imageTools: ReturnType<typeof createImageTools>;
  tableTools: ReturnType<typeof createTableTools>;
  serialize_fn: (node: ProseNode) => string;
  headingsFor_fn: typeof documentHeadings;
}

export function createEditorViews({
  ctx,
  path,
  transformUrl,
  active_fn,
  editable_fn,
  readOnly_fn,
  onNotice,
  scrollbars,
  imageTools,
  tableTools,
  serialize_fn,
  headingsFor_fn,
}: EditorViewsOptions): Pick<EditorProps, "nodeViews" | "markViews" | "decorations"> {
  const decorations = new WeakMap<ProseNode, DecorationSet>();
  const imageView = imageTools.nodeView({ active_fn, editable_fn, path, transformUrl, serialize_fn });
  return {
    nodeViews: {
      wiki_link: wikiNodeView(path, transformUrl),
      ...createMathNodeViews(ctx),
      list_item(node, view, getPos) {
        const dom = document.createElement("li");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "folio-task-checkbox";
        checkbox.contentEditable = "false";
        const contentDOM = document.createElement("div");
        let marker: HTMLSpanElement | null = null;
        dom.setAttribute("role", "listitem");
        dom.append(checkbox, contentDOM);
        const update = () => {
          checkbox.hidden = node.attrs.checked == null;
          checkbox.checked = node.attrs.checked === true;
          checkbox.disabled = readOnly_fn();
          checkbox.setAttribute("aria-label", checkbox.checked ? "Mark task incomplete" : "Mark task complete");
          dom.classList.toggle("folio-task-item", node.attrs.checked != null);
          dom.classList.toggle("folio-image-leading", node.firstChild?.type.name === "image_block");
          if (node.firstChild?.type.name === "image_block" && node.attrs.checked == null) {
            if (!marker) {
              marker = document.createElement("span");
              marker.className = "folio-list-marker";
              marker.contentEditable = "false";
              marker.setAttribute("aria-hidden", "true");
            }
            if (!marker.isConnected) dom.insertBefore(marker, contentDOM);
          } else marker?.remove();
        };
        checkbox.addEventListener("change", () => {
          const position = getPos();
          if (!active_fn() || typeof position !== "number") return;
          if (readOnly_fn()) {
            update();
            onNotice?.("This document is read-only.", "warning");
            return;
          }
          view.dispatch(view.state.tr.setNodeMarkup(position, undefined, { ...node.attrs, checked: checkbox.checked }));
        });
        update();
        return {
          dom,
          contentDOM,
          update(next) {
            if (next.type !== node.type) return false;
            node = next;
            update();
            return true;
          },
          stopEvent: (event) => event.target === checkbox,
          ignoreMutation: (mutation) => mutation.type !== "selection" && !contentDOM.contains(mutation.target),
        };
      },
      code_block: codeBlockNodeView(scrollbars),
      image: imageView,
      image_block: imageView,
      table: tableTools.nodeView({ active_fn, editable_fn, serialize_fn }),
    },
    markViews: { link: (mark) => linkMarkView(mark, path, transformUrl) },
    decorations(state) {
      const cached = decorations.get(state.doc);
      if (cached) return cached;
      const items = headingsFor_fn(state.doc).map(({ node, position, id }) =>
        Decoration.node(position, position + node.nodeSize, { id }),
      );
      const first = state.doc.firstChild;
      if (state.doc.childCount === 1 && first?.type.name === "paragraph" && !first.content.size) {
        items.push(Decoration.node(0, first.nodeSize, { "data-placeholder": "Start writing, or type / to insert" }));
      }
      items.push(...codeBlockDecorations(state.doc));
      const result = DecorationSet.create(state.doc, items);
      decorations.set(state.doc, result);
      return result;
    },
  };
}
