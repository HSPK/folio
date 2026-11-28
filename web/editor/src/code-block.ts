import { Decoration } from "@milkdown/prose/view";
import { TextSelection } from "@milkdown/prose/state";
import type { Node } from "@milkdown/prose/model";
import type { EditorView, NodeViewConstructor } from "@milkdown/prose/view";
import type { DeferredScrollbars } from "./types/editor.ts";
import { createDiagram } from "./diagram.ts";

let syntax: typeof import("./code-syntax.ts") | undefined;
let loading: Promise<void> | undefined;
export function loadCodeSyntax() {
  return (loading ??= import("./code-syntax.ts")
    .then((module) => {
      syntax = module;
    })
    .catch((error) => {
      loading = undefined;
      throw error;
    }));
}

const languageAliases: [string, string[], boolean?][] = [
  ["C", ["c"], true],
  ["C++", ["c++", "cpp", "cc", "cxx", "h", "hpp"], true],
  ["JavaScript", ["javascript", "js", "mjs", "cjs"], true],
  ["JSX", ["jsx"], true],
  ["TypeScript", ["typescript", "ts"], true],
  ["TSX", ["tsx"], true],
  ["Rust", ["rust", "rs"], true],
  ["Python", ["python", "py"]],
  ["HTML", ["html"]],
  ["CSS", ["css"]],
  ["JSON", ["json"]],
  ["YAML", ["yaml", "yml"]],
  ["SQL", ["sql"]],
  ["Markdown", ["markdown", "md"]],
  ["Mermaid", ["mermaid"]],
  ["Shell", ["shell", "sh"]],
  ["Bash", ["bash"]],
  ["Plain text", ["", "text", "plain", "plaintext", "txt"]],
];
const languages = new Map<string, { label: string; supported?: boolean }>(
  languageAliases.flatMap(([label, aliases, supported]) => aliases.map((alias) => [alias, { label, supported }])),
);

function languageInfo(language = "") {
  const name = language.trim().split(/\s+/)[0];
  return languages.get(name.toLowerCase()) ?? { label: name };
}

const highlights = new WeakMap<Node, readonly (readonly [number, number, string])[]>();

/** An untouched code block keeps its node across edits, so it is highlighted once rather than on every keystroke. */
function codeHighlights(node: Node, pending?: (node: Node) => void) {
  let ranges = highlights.get(node);
  if (!ranges) {
    const { label, supported } = languageInfo(node.attrs.language);
    if (supported && node.content.size && !syntax) {
      pending?.(node);
      return [];
    }
    ranges = supported && node.content.size ? syntax!.highlight(label, node.textContent) : [];
    highlights.set(node, ranges);
  }
  return ranges;
}

/** Collect the highlights of every code block inside `node`, which starts at `position` in its document. */
export function codeBlockDecorationsAt(
  node: Node,
  position: number,
  decorations: Decoration[] = [],
  pending?: (node: Node) => void,
) {
  if (node.type.name === "code_block") {
    for (const [from, to, classes] of codeHighlights(node, pending))
      decorations.push(Decoration.inline(position + 1 + from, position + 1 + to, { class: classes }));
    // Only containers can hold a code block; prose text is never walked.
  } else if (!node.isTextblock && !node.isLeaf)
    node.forEach((child, offset) => codeBlockDecorationsAt(child, position + 1 + offset, decorations, pending));
  return decorations;
}

export function codeBlockDecorations(document: Node, pending?: (node: Node) => void) {
  const decorations: Decoration[] = [];
  document.forEach((child, offset) => codeBlockDecorationsAt(child, offset, decorations, pending));
  return decorations;
}

export function decorateCodeBlocks(root: ParentNode) {
  for (const code of root.querySelectorAll<HTMLElement>("pre > code")) {
    const language = [...code.classList].find((name) => name.startsWith("language-"))?.slice(9) ?? "";
    if (code.parentElement) code.parentElement.dataset.codeLanguage = languageInfo(language).label;
    if (languageInfo(language).label === "Mermaid") code.parentElement?.before(createDiagram(code.textContent ?? ""));
  }
}

// Each chunk is a single preformatted run. Editing one line never rebuilds earlier line boxes.
function updateGutter(gutter: HTMLElement, previous: number, count: number) {
  if (previous === count) return;
  const size = 128;
  const chunks = Math.ceil(count / size);
  while (gutter.childElementCount > chunks) gutter.lastElementChild!.remove();
  for (let index = Math.floor(Math.min(previous, count) / size); index < chunks; index++) {
    const start = index * size + 1;
    const label = gutter.children[index] ?? gutter.appendChild(document.createElement("span"));
    label.textContent = Array.from({ length: Math.min(size, count - start + 1) }, (_, i) => start + i).join("\n");
  }
}

type ObserveCode = (dom: HTMLElement, view: EditorView, getPos: () => number | undefined) => () => void;

export function codeBlockNodeView(scrollbars: DeferredScrollbars, observe: ObserveCode): NodeViewConstructor {
  return function code_block(node, view, getPos) {
    const dom = document.createElement("div");
    dom.className = "folio-code-block";
    const language = document.createElement("span");
    language.className = "folio-code-language";
    language.contentEditable = "false";
    language.setAttribute("aria-label", "Code language");
    language.addEventListener("mousedown", (event) => event.preventDefault());
    const gutter = document.createElement("div");
    gutter.className = "folio-code-gutter";
    gutter.contentEditable = "false";
    gutter.setAttribute("aria-hidden", "true");
    const pre = document.createElement("pre");
    const contentDOM = document.createElement("code");
    const scrollHost = document.createElement("div");
    scrollHost.className = "folio-code-scroll";
    scrollHost.setAttribute("data-overlayscrollbars-initialize", "");
    pre.append(contentDOM);
    scrollHost.append(pre);
    dom.append(language, gutter, scrollHost);
    const scrollbar = scrollbars.attach({ host: scrollHost, viewport: pre });
    const unobserve = observe(dom, view, getPos);
    let renderedText: string | null = null;
    let renderedLines = 0;
    let renderedLanguage: string | null = null;
    let diagram: ReturnType<typeof createDiagram> | undefined;
    let toggle: HTMLButtonElement | undefined;
    const editing = (show: boolean) => {
      dom.toggleAttribute("data-diagram-source", show);
      if (!toggle) return;
      toggle.textContent = show ? "Hide source" : "Show source";
      toggle.setAttribute("aria-expanded", String(show));
    };
    const selectionChanged = () => {
      if (
        !dom.hasAttribute("data-diagram-source") &&
        view.hasFocus() &&
        contentDOM.contains(document.getSelection()?.anchorNode ?? null)
      )
        editing(true);
    };
    const update = () => {
      const text = node.textContent;
      if (text !== renderedText) {
        let count = 1;
        for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) count++;
        updateGutter(gutter, renderedLines, count);
        dom.style.setProperty("--code-lines", String(count));
        renderedLines = count;
        renderedText = text;
      }
      const value = node.attrs.language ?? "";
      if (value !== renderedLanguage) {
        dom.dataset.language = value;
        language.textContent = languageInfo(value).label;
        renderedLanguage = value;
        if (languageInfo(value).label === "Mermaid" && !diagram) {
          diagram = createDiagram(text);
          toggle = document.createElement("button");
          toggle.type = "button";
          toggle.contentEditable = "false";
          toggle.className = "folio-diagram-toggle";
          toggle.addEventListener("click", () => {
            const show = !dom.hasAttribute("data-diagram-source");
            editing(show);
            const pos = getPos();
            if (show && view.editable && pos !== undefined) {
              view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 1)));
              view.focus();
            }
          });
          dom.append(toggle, diagram);
          editing(false);
          document.addEventListener("selectionchange", selectionChanged);
        } else if (diagram && languageInfo(value).label !== "Mermaid") {
          diagram.remove();
          toggle?.remove();
          diagram = toggle = undefined;
          document.removeEventListener("selectionchange", selectionChanged);
          dom.removeAttribute("data-diagram-source");
        }
      }
      diagram?.setSource(text);
    };
    update();
    return {
      dom,
      contentDOM,
      destroy: () => {
        unobserve();
        scrollbar.destroy();
        document.removeEventListener("selectionchange", selectionChanged);
      },
      update(next) {
        if (next.type !== node.type) return false;
        node = next;
        update();
        return true;
      },
      stopEvent: (event) =>
        event.target instanceof globalThis.Node &&
        (language.contains(event.target) || !!toggle?.contains(event.target) || !!diagram?.contains(event.target)),
      ignoreMutation: (mutation) => mutation.type !== "selection" && !contentDOM.contains(mutation.target),
    };
  };
}
