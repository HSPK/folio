import type { Node as ProseNode } from "@milkdown/prose/model";
import type { EditorView } from "@milkdown/prose/view";
import { documentHeadings, sourceOffset } from "./markdown.ts";
import { sessionPositionMap, sessionSource } from "./editor-session.ts";
import { lineColumn } from "./cursor-coordinates.ts";
import type { EditorSession, InlineEditorOptions, OutlineExtractor } from "./types/editor.ts";

type AnalysisOptions = Pick<InlineEditorOptions, "onOutline" | "onSelection" | "onHeadingSelection"> & {
  active: (state: EditorSession) => boolean;
  trackOutline: () => boolean;
  trackSelection: () => boolean;
  outlineExtractor: OutlineExtractor;
};

export function createEditorAnalysis({
  active,
  trackOutline,
  trackSelection,
  outlineExtractor,
  onOutline,
  onSelection,
  onHeadingSelection,
}: AnalysisOptions) {
  const headings = new WeakMap<ProseNode, ReturnType<typeof documentHeadings>>();
  function headingsFor(document: ProseNode) {
    let items = headings.get(document);
    if (!items) {
      items = documentHeadings(document);
      headings.set(document, items);
    }
    return items;
  }
  function sourcePosition(state: EditorSession, view: EditorView, position: number) {
    return state.parts.bodyStart + sourceOffset(sessionPositionMap(state, view), position);
  }
  return {
    headingsFor,
    sourcePosition,
    publishOutline(state: EditorSession) {
      if (!active(state) || !onOutline || !trackOutline()) return;
      const items = outlineExtractor.extract(sessionSource(state));
      const signature = JSON.stringify(items);
      if (signature !== state.outlineSignature) {
        state.outlineSignature = signature;
        onOutline(items);
      }
    },
    publishSelection(state: EditorSession, view = state.view) {
      if (!active(state) || !view || !state.ready || !trackSelection()) return;
      if (onHeadingSelection) {
        const heading = headingsFor(view.state.doc).findLast((item) => item.position < view.state.selection.head);
        onHeadingSelection(heading?.id ?? null);
      }
      onSelection?.(lineColumn(sessionSource(state), sourcePosition(state, view, view.state.selection.head)));
    },
  };
}
