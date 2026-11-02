import { Decoration } from "@milkdown/prose/view";
import { parser as cppParser } from "@lezer/cpp";
import { parser as javascriptParser } from "@lezer/javascript";
import { parser as rustParser } from "@lezer/rust";
import { tags, tagHighlighter, highlightTree } from "@lezer/highlight";
import type { Node } from "@milkdown/prose/model";
import type { NodeViewConstructor } from "@milkdown/prose/view";
import type { Parser } from "@lezer/common";
import type { DeferredScrollbars } from "./types/editor.ts";

const codeHighlighter = tagHighlighter([
  { tag: tags.keyword, class: "folio-code-keyword" },
  { tag: [tags.string, tags.character], class: "folio-code-string" },
  { tag: [tags.number, tags.bool, tags.null], class: "folio-code-number" },
  { tag: tags.comment, class: "folio-code-comment" },
  { tag: tags.typeName, class: "folio-code-type" },
  { tag: tags.function(tags.variableName), class: "folio-code-function" },
]);

interface LanguageInfo {
  label: string;
  parser?: Parser | null;
}

const languageAliases: [string, string[], Parser?][] = [
  ["C", ["c"], cppParser],
  ["C++", ["c++", "cpp", "cc", "cxx", "h", "hpp"], cppParser],
  ["JavaScript", ["javascript", "js", "mjs", "cjs"], javascriptParser],
  ["JSX", ["jsx"], javascriptParser.configure({ dialect: "jsx" })],
  ["TypeScript", ["typescript", "ts"], javascriptParser.configure({ dialect: "ts" })],
  ["TSX", ["tsx"], javascriptParser.configure({ dialect: "ts jsx" })],
  ["Rust", ["rust", "rs"], rustParser],
  ["Python", ["python", "py"]],
  ["HTML", ["html"]],
  ["CSS", ["css"]],
  ["JSON", ["json"]],
  ["YAML", ["yaml", "yml"]],
  ["SQL", ["sql"]],
  ["Markdown", ["markdown", "md"]],
  ["Shell", ["shell", "sh"]],
  ["Bash", ["bash"]],
  ["Plain text", ["", "text", "plain", "plaintext", "txt"]],
];
const languages = new Map<string, LanguageInfo>(
  languageAliases.flatMap(([label, aliases, parser]) => aliases.map((alias) => [alias, { label, parser }])),
);

function languageInfo(language = "") {
  const name = language.trim().split(/\s+/)[0];
  return languages.get(name.toLowerCase()) ?? { label: name, parser: null };
}

export function codeBlockDecorations(document: Node) {
  const decorations: Decoration[] = [];
  document.descendants((node, position) => {
    if (node.type.name !== "code_block" || !node.textContent) return;
    const { parser } = languageInfo(node.attrs.language);
    if (parser)
      highlightTree(parser.parse(node.textContent), codeHighlighter, (from, to, classes) => {
        if (to > from) decorations.push(Decoration.inline(position + 1 + from, position + 1 + to, { class: classes }));
      });
  });
  return decorations;
}

export function decorateCodeBlocks(root: ParentNode) {
  for (const code of root.querySelectorAll<HTMLElement>("pre > code")) {
    const language = [...code.classList].find((name) => name.startsWith("language-"))?.slice(9) ?? "";
    if (code.parentElement) code.parentElement.dataset.codeLanguage = languageInfo(language).label;
  }
}

export function codeBlockNodeView(scrollbars: DeferredScrollbars): NodeViewConstructor {
  return function code_block(node) {
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
    let renderedText: string | null = null;
    let renderedLanguage: string | null = null;
    const update = () => {
      const text = node.textContent;
      if (text !== renderedText) {
        const count = text.split("\n").length;
        if (gutter.childElementCount !== count) {
          gutter.replaceChildren(
            ...Array.from({ length: count }, (_, index) => {
              const number = document.createElement("span");
              number.textContent = String(index + 1);
              return number;
            }),
          );
        }
        renderedText = text;
      }
      const value = node.attrs.language ?? "";
      if (value !== renderedLanguage) {
        dom.dataset.language = value;
        language.textContent = languageInfo(value).label;
        renderedLanguage = value;
      }
    };
    update();
    return {
      dom,
      contentDOM,
      destroy: () => scrollbar.destroy(),
      update(next) {
        if (next.type !== node.type) return false;
        node = next;
        update();
        return true;
      },
      stopEvent: (event) => event.target instanceof globalThis.Node && language.contains(event.target),
      ignoreMutation: (mutation) => mutation.type !== "selection" && !contentDOM.contains(mutation.target),
    };
  };
}
