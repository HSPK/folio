import { parserCtx, serializerCtx } from "@milkdown/core";
import { historyProviderPlugin } from "@milkdown/plugin-history";
import { splitFrontMatter } from "./editor-helpers.ts";
import { parseBody, unsupportedBody } from "./markdown.ts";
import { proveLiveBody } from "./literal-block.ts";
import type { EditorSession } from "./types/editor.ts";
import { rebaseImagePreviews } from "./image-preview.ts";

export function replaceRemoteSource(state: EditorSession, source: string, resetHistory = false) {
  const { editor, view, bodySerializer } = state;
  if (!state.ready || !editor || !view || !bodySerializer) return false;
  const parts = splitFrontMatter(source);
  if (parts.hasMetadata !== state.parts.hasMetadata) return false;
  const ast = parseBody(parts.body);
  if (unsupportedBody(ast, parts.body)) return false;
  const proof = editor.action((ctx) =>
    proveLiveBody(ctx.get(parserCtx)(parts.body), parts.body, ast, ctx.get(serializerCtx)),
  );
  if (!proof) return false;
  const { document: doc } = proof;
  state.ready = false;
  try {
    state.parts = parts;
    state.bodySource = parts.body;
    state.originalBody = parts.body;
    state.bodyAst = ast;
    state.bodyAstSource = parts.body;
    bodySerializer.reset(doc, parts.body, ast);
    state.initialDoc = doc;
    if (!view.state.doc.eq(doc)) {
      const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content);
      view.dispatch(
        rebaseImagePreviews(tr, view, source, parts, ast)
          .setMeta("addToHistory", false)
          .setMeta("folio-link-edit", true),
      );
    }
    if (resetHistory) {
      // A Markdown history replay supersedes this mount's redo branch. Keep unrelated
      // plugin state (notably pending image bookmarks), only reinitialize PM history.
      const plugins = view.state.plugins;
      const fresh = view.state.reconfigure({
        plugins: plugins.filter((plugin) => plugin !== historyProviderPlugin.plugin()),
      });
      view.updateState(fresh.reconfigure({ plugins }));
    }
    if (state.metadata && parts.hasMetadata) {
      if (!state.refreshMetadata) throw new Error("The metadata editor is missing its refresh callback.");
      state.refreshMetadata();
    }
  } finally {
    state.ready = true;
  }
  return true;
}
