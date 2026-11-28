import { history } from "@codemirror/commands";
import { StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { parsedHighlights } from "./code-file-highlights.ts";
import { codeTokenStyle } from "./code-token-style.ts";
import { sourceCommands } from "./source-commands.ts";
import "./source-editor.css";

interface CodeSourceOptions {
  path: string;
  content: string;
  readOnly: boolean;
  onChange: () => void;
  onSave: () => void;
}

export function mountCodeSource(host: HTMLElement, { path, content, readOnly, onChange, onSave }: CodeSourceOptions) {
  const root = host.ownerDocument.createElement("div");
  root.className = "folio-source-surface folio-code-source";
  host.append(root);
  const syntax = new Compartment();
  const nonce = host.ownerDocument.querySelector<HTMLMetaElement>('meta[name="folio-style-nonce"]')?.content ?? "";
  let destroyed = false;
  const view = new EditorView({
    parent: root,
    state: EditorState.create({
      doc: content,
      extensions: [
        EditorView.cspNonce.of(nonce),
        EditorView.contentAttributes.of({
          "aria-label": "Source code",
          "aria-multiline": "true",
          tabindex: "0",
          autocomplete: "off",
          autocapitalize: "off",
          spellcheck: "false",
        }),
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
        EditorState.tabSize.of(4),
        keymap.of([
          {
            key: "Mod-s",
            run: () => {
              if (!readOnly) onSave();
              return true;
            },
            stopPropagation: true,
          },
        ]),
        readOnly ? [] : history(),
        sourceCommands,
        syntax.of([]),
        EditorView.updateListener.of(({ docChanged }) => {
          if (docChanged) onChange();
        }),
      ],
    }),
  });
  const ext = path.split(".").at(-1)?.toLowerCase() ?? "";
  void import("./code-syntax.ts")
    .then((module) => {
      if (destroyed) return;
      const parser = module.codeFileParser(ext);
      const mode = module.codeFileMode(ext);
      if (parser || mode)
        view.dispatch({
          effects: syntax.reconfigure(
            parser ? parsedHighlights(parser) : [StreamLanguage.define(mode!), syntaxHighlighting(codeTokenStyle)],
          ),
        });
    })
    .catch(() => {
      /* An unavailable syntax asset must not prevent editing or saving. */
    });
  return {
    getValue: () => view.state.doc.toString(),
    focus: () => view.focus(),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      view.destroy();
      root.remove();
    },
  };
}
