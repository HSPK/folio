import { parserCtx, serializerCtx } from "@milkdown/core";
import { splitFrontMatter } from "./editor-helpers.ts";
import { parseBody, bodyFingerprint, unsupportedBody } from "./markdown.ts";
import { normalizeSerializedBody } from "./roundtrip.ts";
import { serializedBodyTree } from "./body-serialization.ts";
import type { EditorSession } from "./types/editor.ts";

export function replaceRemoteSource(state: EditorSession, source: string) {
  const { editor, view, bodySerializer } = state;
  if (!state.ready || !editor || !view || !bodySerializer) return false;
  const parts = splitFrontMatter(source);
  if (parts.hasMetadata !== state.parts.hasMetadata) return false;
  const ast = parseBody(parts.body);
  if (unsupportedBody(ast, parts.body)) return false;
  const doc = editor.action((ctx) => ctx.get(parserCtx)(parts.body));
  const serialized = editor.action((ctx) => ctx.get(serializerCtx)(doc));
  const canonical = normalizeSerializedBody(serialized);
  const canonicalTree = serializedBodyTree({ source: parts.body, tree: ast, serialized: canonical });
  if (canonicalTree !== ast && bodyFingerprint(ast) !== bodyFingerprint(canonicalTree)) return false;
  state.ready = false;
  try {
    state.parts = parts;
    state.bodySource = parts.body;
    state.originalBody = parts.body;
    state.bodyAst = ast;
    state.bodyAstSource = parts.body;
    bodySerializer.reset(doc, canonical, canonicalTree);
    state.initialDoc = doc;
    if (!view.state.doc.eq(doc)) {
      view.dispatch(
        view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content).setMeta("addToHistory", false),
      );
    }
    if (state.metadata && parts.hasMetadata) {
      state.metadata.textarea.value = parts.raw.replace(/\r\n?/g, "\n");
      if (!state.refreshMetadata) throw new Error("The metadata editor is missing its refresh callback.");
      state.refreshMetadata();
    }
  } finally {
    state.ready = true;
  }
  return true;
}
