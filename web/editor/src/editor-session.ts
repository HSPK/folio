import type { EditorSession, MetadataBody, ReadyEditorSession } from "./types/editor.ts";
import type { EditorView } from "@milkdown/prose/view";
import { parseBody, sourcePositionMap } from "./markdown.ts";

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
