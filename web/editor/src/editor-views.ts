import type { Ctx } from "@milkdown/ctx";
import type { Node as ProseNode } from "@milkdown/prose/model";
import { Decoration, DecorationSet, type EditorProps, type EditorView } from "@milkdown/prose/view";
import { createMathNodeViews } from "./math.ts";
import { wikiNodeView } from "./wiki.ts";
import { Mapping, StepMap } from "@milkdown/prose/transform";
import { indexedDecorations } from "./decoration-index.ts";
import { codeBlockDecorations, codeBlockDecorationsAt, codeBlockNodeView, loadCodeSyntax } from "./code-block.ts";
import { linkMarkView } from "./links.ts";
import type { createImageTools } from "./images.ts";
import type { createTableTools } from "./tables.ts";
import type { documentHeadings } from "./markdown.ts";
import type { DeferredScrollbars, InlineEditorOptions, MarkdownUrl, NodeActivity } from "./types/editor.ts";

interface EditorViewsOptions extends NodeActivity {
  ctx: Ctx;
  viewport: HTMLElement;
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
  viewport,
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
  let decorations = new WeakMap<ProseNode, DecorationSet>();
  let latest: { document: ProseNode; inner: DecorationSet } | null = null;
  const waiting = new Map<Element, () => number | undefined>();
  let observer: IntersectionObserver | null = null;
  let deferCode: boolean | undefined;
  let host: EditorView | undefined;
  const pending = new Set<ProseNode>();
  function queueHighlight(node: ProseNode) {
    const first = !pending.size;
    pending.add(node);
    if (first)
      void loadCodeSyntax()
        .then(() => {
          const view = host;
          // Cached versions used by undo may have been decorated before syntax arrived.
          decorations = new WeakMap();
          if (!view || view.isDestroyed || latest?.document !== view.state.doc) return;
          const fresh: Decoration[] = [];
          view.state.doc.descendants((current, pos) => {
            if (pending.has(current) && !latest!.inner.find(pos + 1, pos + current.nodeSize - 1).length)
              codeBlockDecorationsAt(current, pos, fresh);
            return !current.isTextblock;
          });
          if (!fresh.length) return;
          latest.inner = latest.inner.add(view.state.doc, fresh);
          decorations = new WeakMap([[view.state.doc, combine(view.state.doc, latest.inner)]]);
          view.updateState(view.state);
        })
        .finally(() => pending.clear())
        .catch(() => {}); // Plain code remains editable if the optional download fails.
  }
  function watchCode(dom: Element, view: EditorView, getPos: () => number | undefined) {
    host = view;
    if (!deferCode) return () => {};
    waiting.set(dom, getPos);
    observer ??= new IntersectionObserver(
      (entries) => {
        if (view.isDestroyed || latest?.document !== view.state.doc) return;
        const fresh: Decoration[] = [];
        for (const { target, isIntersecting } of entries) {
          if (!isIntersecting) continue;
          const pos = waiting.get(target)?.();
          if (pos === undefined) continue;
          observer?.unobserve(target);
          waiting.delete(target);
          const node = view.state.doc.nodeAt(pos);
          if (!node || node.type.name !== "code_block" || latest.inner.find(pos + 1, pos + node.nodeSize - 1).length)
            continue;
          codeBlockDecorationsAt(node, pos, fresh, queueHighlight);
        }
        if (!fresh.length) return;
        latest.inner = latest.inner.add(view.state.doc, fresh);
        decorations = new WeakMap([[view.state.doc, combine(view.state.doc, latest.inner)]]);
        view.updateState(view.state);
      },
      { root: viewport, rootMargin: "600px 0px" },
    );
    observer.observe(dom);
    return () => {
      observer?.unobserve(dom);
      waiting.delete(dom);
      if (!waiting.size) {
        observer?.disconnect();
        observer = null;
      }
    };
  }
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
            onNotice?.("Read-only", "warning");
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
      code_block: codeBlockNodeView(scrollbars, watchCode),
      image: imageView,
      image_block: imageView,
      table: tableTools.nodeView({ active_fn, editable_fn, serialize_fn }),
    },
    markViews: { link: (mark) => linkMarkView(mark, path, transformUrl) },
    decorations(state) {
      deferCode ??= state.doc.content.size >= 16_384 && typeof IntersectionObserver !== "undefined";
      const cached = decorations.get(state.doc);
      if (cached && ((!deferCode && !pending.size) || latest?.document === state.doc)) return cached;
      const inner = (latest && patchInner(latest.document, latest.inner, state.doc)) ?? buildInner(state.doc);
      const result = combine(state.doc, inner);
      decorations.set(state.doc, result);
      latest = { document: state.doc, inner };
      return result;
    },
  };

  /** Heading anchors on top-level blocks are cheap to list afresh; they sit beside the inner set. */
  function combine(document: ProseNode, inner: DecorationSet) {
    const top = headingsFor_fn(document)
      .filter((heading) => heading.top)
      .map(headingDecoration);
    const first = document.firstChild;
    if (document.childCount === 1 && first?.type.name === "paragraph" && !first.content.size) {
      top.push(Decoration.node(0, first.nodeSize, { "data-placeholder": "Start writing, or type / to insert" }));
    }
    return indexedDecorations(top, inner) ?? DecorationSet.create(document, [...top, ...inner.find()]);
  }

  function nestedHeadings(document: ProseNode) {
    return headingsFor_fn(document).filter((heading) => !heading.top);
  }

  /** Decorations inside blocks: code highlights, and anchors of headings nested in quotes or lists. */
  function buildInner(document: ProseNode) {
    return DecorationSet.create(document, [
      ...nestedHeadings(document).map(headingDecoration),
      // The initial view paints syntax just ahead of the viewport. Subsequent full rebuilds
      // (e.g. a nested heading edit) must also cover existing, already observed node views.
      ...(deferCode && !latest ? [] : codeBlockDecorations(document, queueHighlight)),
    ]);
  }

  /**
   * Carry the inner decorations across an edit and redo only the top-level blocks that changed, so a
   * keystroke in a long note does not re-highlight every code block. Returns null when anchors nested
   * inside blocks are involved, because those are numbered across the whole note.
   */
  function patchInner(before: ProseNode, inner: DecorationSet, document: ProseNode) {
    if (nestedHeadings(before).length || nestedHeadings(document).length) return null;
    let from = 0;
    let endA = before.childCount;
    let endB = document.childCount;
    while (from < Math.min(endA, endB) && before.child(from) === document.child(from)) from += 1;
    while (endA > from && endB > from && before.child(endA - 1) === document.child(endB - 1)) {
      endA -= 1;
      endB -= 1;
    }
    let start = 0;
    for (let index = 0; index < from; index += 1) start += document.child(index).nodeSize;
    let oldSize = 0;
    for (let index = from; index < endA; index += 1) oldSize += before.child(index).nodeSize;
    let newSize = 0;
    for (let index = from; index < endB; index += 1) newSize += document.child(index).nodeSize;
    const mapped = inner.map(new Mapping([new StepMap([start, oldSize, newSize])]), document);
    const end = start + newSize;
    const stale = mapped.find(start, end).filter((decoration) => decoration.from >= start && decoration.to <= end);
    const fresh: Decoration[] = [];
    let position = start;
    for (let index = from; index < endB; index += 1) {
      codeBlockDecorationsAt(document.child(index), position, fresh, queueHighlight);
      position += document.child(index).nodeSize;
    }
    return mapped.remove(stale).add(document, fresh);
  }
}

const headingDecoration = ({ node, position, id }: { node: ProseNode; position: number; id: string }) =>
  Decoration.node(position, position + node.nodeSize, { id });
