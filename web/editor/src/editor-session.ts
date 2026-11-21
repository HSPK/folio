import type { EditorSession, MetadataBody, ReadyEditorSession } from "./types/editor.ts";
import type { EditorView } from "@milkdown/prose/view";
import { Fragment, type Node as ProseNode } from "@milkdown/prose/model";
import { parseBody, sourceOffset, sourcePositionMap } from "./markdown.ts";

export const sessionSource = (state: EditorSession) => state.parts.prefix + state.bodySource;

export function hasMetadata(state: EditorSession): state is EditorSession & { parts: MetadataBody } {
  return state.parts.hasMetadata;
}

export function isReadySession(state: EditorSession | null | undefined): state is ReadyEditorSession {
  if (!state?.ready) return false;
  if (!state.editor || !state.view || !state.initialDoc || !state.bodySerializer) {
    throw new Error("The formatted editor became ready without its editing state.");
  }
  return true;
}

const blockMaps = new WeakMap<ProseNode, { source: string; map: ReturnType<typeof sourcePositionMap> }>();

/** Map a position through its own top-level block, so a caret lookup never re-reads the whole note. */
function blockSourceOffset(state: EditorSession, document: ProseNode, position: number) {
  if (position <= 0 || position >= document.content.size) return null;
  const resolved = document.resolve(position);
  if (resolved.depth < 1) return null;
  const range = state.bodySerializer?.blockRange(document, state.bodySource, resolved.index(0));
  if (!range) return null;
  const block = resolved.node(1);
  const source = state.bodySource.slice(range.from, range.to);
  let entry = blockMaps.get(block);
  if (entry?.source !== source) {
    entry = { source, map: sourcePositionMap(parseBody(source), source, document.copy(Fragment.from(block))) };
    blockMaps.set(block, entry);
  }
  return range.from + sourceOffset(entry.map, position - resolved.before(1));
}

export function sessionSourceOffset(state: EditorSession, view: EditorView, position: number) {
  const current = state.map && state.mapDocument === view.state.doc && state.mapSource === state.bodySource;
  const local = current ? null : blockSourceOffset(state, view.state.doc, position);
  return local ?? sourceOffset(sessionPositionMap(state, view), position);
}

export function sessionPositionMap(state: EditorSession, view: EditorView) {
  if (!state.map || state.mapDocument !== view.state.doc || state.mapSource !== state.bodySource) {
    if (state.bodyAstSource !== state.bodySource) {
      state.bodyAst = parseBody(state.bodySource);
      state.bodyAstSource = state.bodySource;
    }
    state.map = sourcePositionMap(state.bodyAst, state.bodySource, view.state.doc);
    state.mapDocument = view.state.doc;
    state.mapSource = state.bodySource;
  }
  return state.map;
}
