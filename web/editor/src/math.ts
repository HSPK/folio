import "katex/dist/katex.min.css";
import remarkMath from "remark-math";
import { $ctx, $inputRule, $nodeSchema, $remark } from "@milkdown/utils";
import { InputRule } from "@milkdown/prose/inputrules";
import { TextSelection } from "@milkdown/prose/state";
import { createCachedKatexRenderer } from "./katex-renderer.ts";
import { remarkDisplayMath } from "./math-syntax.ts";
import type { Ctx } from "@milkdown/ctx";
import type { Node as ProseNode } from "@milkdown/prose/model";
import type { EditorView, NodeViewConstructor } from "@milkdown/prose/view";
import type { KatexOptions } from "katex";
import type { GetPosition } from "./types/editor.ts";

export const remarkMathPlugin = $remark("remarkMath", () => remarkMath);

export const remarkDisplayMathPlugin = $remark("remarkDisplayMath", () => remarkDisplayMath);

export const katexOptionsCtx = $ctx<KatexOptions, "katexOptions">(
  {
    throwOnError: false,
    strict: "ignore",
    trust: false,
    output: "htmlAndMathml",
  },
  "katexOptions",
);

type SelectionRoot = (Document | ShadowRoot) & { getSelection?: () => Selection | null };
type ActivateMath = (dom: HTMLElement, view: EditorView, getPos: GetPosition) => void;
type CacheableMath = (view: EditorView, value: string) => boolean;

function setDomTextSelection(source: HTMLElement, anchor: number, head: number, root: SelectionRoot) {
  const point = (offset: number): [Node, number] => {
    const walker = source.ownerDocument.createTreeWalker(source, 4);
    let node;
    let last: Node | null = null;
    while ((node = walker.nextNode())) {
      last = node;
      const length = node.textContent?.length ?? 0;
      if (offset <= length) return [node, offset];
      offset -= length;
    }
    return last ? [last, last.textContent?.length ?? 0] : [source, 0];
  };
  const selection = root.getSelection?.() ?? root.ownerDocument?.getSelection();
  if (!selection) return;
  const [anchorNode, anchorOffset] = point(anchor);
  const [headNode, headOffset] = point(head);
  const range = source.ownerDocument.createRange();
  range.setStart(anchorNode, anchorOffset);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  if (head !== anchor) selection.extend(headNode, headOffset);
}

function repeatedMathValues(document: ProseNode) {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  document.descendants((node) => {
    if (!["math_inline", "math_block"].includes(node.type.name)) return;
    const value = node.textContent;
    if (seen.has(value)) repeated.add(value);
    else seen.add(value);
  });
  return repeated;
}

function mathNodeView(
  block: boolean,
  ctx: Ctx,
  activate: ActivateMath,
  deactivate: (dom: HTMLElement) => void,
  render: ReturnType<typeof createCachedKatexRenderer>,
  cacheable: CacheableMath,
): NodeViewConstructor {
  return (initialNode, editorView, getPos) => {
    let node = initialNode;
    const dom: HTMLElement = document.createElement(block ? "div" : "span");
    const ownerWindow = dom.ownerDocument.defaultView;
    if (!ownerWindow) throw new Error("Formula editing requires a browser document.");
    dom.className = `folio-math-node folio-math-${block ? "block" : "inline"}`;
    dom.dataset.type = block ? "math_block" : "math_inline";
    const output: HTMLElement = document.createElement(block ? "div" : "span");
    output.className = "folio-math-output";
    output.contentEditable = "false";
    output.tabIndex = 0;
    output.setAttribute("role", "button");
    output.title = "Click or press Enter to edit this formula";
    const source: HTMLElement = document.createElement(block ? "code" : "span");
    source.className = "folio-math-source";
    source.dataset.mathSource = "";
    source.setAttribute("aria-label", `${block ? "Display" : "Inline"} TeX source`);
    dom.append(output, source);

    let renderFrame = 0;
    let renderedValue: string | undefined;
    let pendingValue = initialNode.textContent;
    const renderNow = (value: string) => {
      renderedValue = value;
      dom.dataset.value = value;
      dom.classList.toggle("is-empty", !value.trim());
      render(value, output, ctx.get(katexOptionsCtx.key), cacheable(editorView, value));
      output.setAttribute(
        "aria-label",
        `${block ? "Display" : "Inline"} formula: ${value || "empty"}. Activate to edit.`,
      );
    };
    const renderValue = (value: string, defer = false) => {
      pendingValue = value;
      dom.dataset.value = value;
      dom.classList.toggle("is-empty", !value.trim());
      if (!defer) {
        renderNow(value);
        return;
      }
      if (value === renderedValue) {
        if (renderFrame) ownerWindow.cancelAnimationFrame(renderFrame);
        renderFrame = 0;
        return;
      }
      if (renderFrame) return;
      renderFrame = ownerWindow.requestAnimationFrame(() => {
        renderFrame = 0;
        renderNow(pendingValue);
      });
    };
    const begin = (atEnd = true) => {
      activate(dom, editorView, getPos);
      const position = getPos();
      if (typeof position === "number") {
        const offset = atEnd ? node.content.size : 0;
        editorView.dispatch(
          editorView.state.tr.setSelection(TextSelection.create(editorView.state.doc, position + 1 + offset)),
        );
        editorView.focus();
      }
    };
    output.addEventListener("mousedown", (event) => {
      event.preventDefault();
      begin();
    });
    output.addEventListener("keydown", (event) => {
      if (["Enter", " "].includes(event.key)) {
        event.preventDefault();
        begin();
      }
    });
    renderValue(node.textContent);
    return {
      dom,
      contentDOM: source,
      stopEvent: (event) => event.target instanceof Node && output.contains(event.target),
      ignoreMutation: (mutation) => !source.contains(mutation.target),
      setSelection(anchor, head, root) {
        activate(dom, editorView, getPos);
        setDomTextSelection(source, anchor, head, root);
      },
      selectNode: () => (block ? dom.classList.add("ProseMirror-selectednode") : activate(dom, editorView, getPos)),
      deselectNode() {
        dom.classList.remove("ProseMirror-selectednode");
        deactivate(dom);
      },
      destroy() {
        if (renderFrame) ownerWindow.cancelAnimationFrame(renderFrame);
        deactivate(dom);
      },
      update(next) {
        if (next.type !== node.type) return false;
        node = next;
        renderValue(node.textContent, true);
        return true;
      },
    };
  };
}

export function createMathNodeViews(ctx: Ctx) {
  let active: { dom: HTMLElement; editorView: EditorView; getPos: GetPosition } | null = null;
  let selectionDocument: Document | null = null;
  let selectionFrame = 0;
  let repeatedValues: Set<string> | null = null;
  const render = createCachedKatexRenderer();
  const cacheable = (editorView: EditorView, value: string) => {
    repeatedValues ??= repeatedMathValues(editorView.state.doc);
    return repeatedValues.has(value);
  };
  const stopListening = () => {
    if (selectionFrame) selectionDocument?.defaultView?.cancelAnimationFrame(selectionFrame);
    selectionFrame = 0;
    selectionDocument?.removeEventListener("selectionchange", selectionChanged);
    selectionDocument = null;
  };
  const selectionChanged = () => {
    const ownerWindow = selectionDocument?.defaultView;
    if (selectionFrame || !ownerWindow) return;
    selectionFrame = ownerWindow.requestAnimationFrame(() => {
      selectionFrame = 0;
      const current = active;
      if (!current) return;
      let position;
      try {
        position = current.getPos();
      } catch {
        deactivate(current.dom);
        return;
      }
      if (typeof position !== "number") {
        deactivate(current.dom);
        return;
      }
      const node = current.editorView.state.doc.nodeAt(position);
      const selection = current.editorView.state.selection;
      const inside = node && selection.from >= position + 1 && selection.to <= position + node.nodeSize - 1;
      const selected = node && selection.from === position && selection.to === position + node.nodeSize;
      if (!inside && !selected) deactivate(current.dom);
    });
  };
  const activate: ActivateMath = (dom, editorView, getPos) => {
    if (active?.dom !== dom) active?.dom.classList.remove("is-editing");
    active = { dom, editorView, getPos };
    dom.classList.add("is-editing");
    if (selectionDocument !== dom.ownerDocument) {
      stopListening();
      selectionDocument = dom.ownerDocument;
      selectionDocument.addEventListener("selectionchange", selectionChanged);
    }
  };
  const deactivate = (dom: HTMLElement) => {
    if (active?.dom !== dom) return;
    dom.classList.remove("is-editing");
    active = null;
    stopListening();
  };
  return {
    math_inline: mathNodeView(false, ctx, activate, deactivate, render, cacheable),
    math_block: mathNodeView(true, ctx, activate, deactivate, render, cacheable),
  };
}

export const mathInlineSchema = $nodeSchema("math_inline", (ctx) => {
  const render = createCachedKatexRenderer();
  return {
    content: "text*",
    group: "inline",
    inline: true,
    isolating: true,
    marks: "",
    whitespace: "pre",
    parseDOM: [
      {
        tag: 'span[data-type="math_inline"]',
        contentElement: "[data-math-source]",
      },
    ],
    toDOM: (node) => {
      const dom = document.createElement("span");
      dom.dataset.type = "math_inline";
      dom.dataset.value = node.textContent;
      const output = document.createElement("span");
      output.className = "folio-math-output";
      const contentDOM = document.createElement("span");
      contentDOM.dataset.mathSource = "";
      render(node.textContent, output, ctx.get(katexOptionsCtx.key));
      dom.append(output, contentDOM);
      return { dom, contentDOM };
    },
    parseMarkdown: {
      match: (node) => node.type === "inlineMath",
      runner: (state, node, type) => {
        if (typeof node.value !== "string") throw new Error("An inline formula is missing its TeX source.");
        state.addNode(type, undefined, node.value ? [state.schema.text(node.value)] : undefined);
      },
    },
    toMarkdown: {
      match: (node) => node.type.name === "math_inline",
      runner: (state, node) => state.addNode("inlineMath", undefined, node.textContent),
    },
  };
});

export const mathBlockSchema = $nodeSchema("math_block", (ctx) => {
  const render = createCachedKatexRenderer();
  return {
    content: "text*",
    group: "block",
    marks: "",
    defining: true,
    isolating: true,
    code: true,
    parseDOM: [
      {
        tag: 'div[data-type="math_block"]',
        preserveWhitespace: "full",
        contentElement: "[data-math-source]",
      },
    ],
    toDOM: (node) => {
      const dom = document.createElement("div");
      dom.dataset.type = "math_block";
      dom.dataset.value = node.textContent;
      const output = document.createElement("div");
      output.className = "folio-math-output";
      const contentDOM = document.createElement("code");
      contentDOM.dataset.mathSource = "";
      render(node.textContent, output, ctx.get(katexOptionsCtx.key));
      dom.append(output, contentDOM);
      return { dom, contentDOM };
    },
    parseMarkdown: {
      match: (node) => node.type === "math",
      runner: (state, node, type) => {
        if (typeof node.value !== "string") throw new Error("A display formula is missing its TeX source.");
        state.addNode(type, undefined, node.value ? [state.schema.text(node.value)] : undefined);
      },
    },
    toMarkdown: {
      match: (node) => node.type.name === "math_block",
      runner: (state, node) => state.addNode("math", undefined, node.textContent),
    },
  };
});

export const mathInlineInputRule = $inputRule(
  (ctx) =>
    new InputRule(/(?:\$)([^$]+)(?:\$)$/, (state, match, start, end) => {
      const type = mathInlineSchema.type(ctx);
      const marks = state.storedMarks ?? state.doc.resolve(start).marks();
      const value = match[1] ?? "";
      return state.tr.replaceWith(start, end, type.create(null, value ? state.schema.text(value) : null, marks));
    }),
);

export const mathBlockInputRule = $inputRule(
  (ctx) =>
    new InputRule(/^\$\$\s$/, (state, _match, start, end) => {
      const position = state.doc.resolve(start);
      return position.node(-1).canReplaceWith(position.index(-1), position.indexAfter(-1), mathBlockSchema.type(ctx))
        ? state.tr.delete(start, end).setBlockType(start, start, mathBlockSchema.type(ctx))
        : null;
    }),
);

export const math = [
  remarkMathPlugin,
  remarkDisplayMathPlugin,
  katexOptionsCtx,
  mathInlineSchema,
  mathBlockSchema,
  mathBlockInputRule,
  mathInlineInputRule,
].flat();
