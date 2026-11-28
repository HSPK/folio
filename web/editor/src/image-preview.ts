import { Plugin, PluginKey, NodeSelection, TextSelection } from "@milkdown/prose/state";
import { closeHistory } from "@milkdown/prose/history";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/prose/view";
import { imageBoundarySelection, imageInsertionTransaction } from "./image-model.ts";
import { syncViewSelection } from "./cursor-coordinates.ts";
import { mapImageRange, type ImageBookmark } from "./image-bookmarks.ts";
import { flushDeferredInput } from "./deferred-input.ts";
import type { ChangedRange, TextSelectionRange, ReadyEditorSession, FrontMatterParts } from "./types/editor.ts";
import { sessionPositionMap } from "./editor-session.ts";
import { documentOffset, sourceOffset, sourcePositionMap } from "./markdown.ts";
import type { Root } from "mdast";
import type { Transaction } from "@milkdown/prose/state";

interface Preview extends TextSelectionRange {
  id: number;
  dom: HTMLElement;
  remote: () => { text: string; range: TextSelectionRange | null } | null;
}
interface PreviewAction {
  add?: Preview;
  remove?: number;
  rebased?: Preview[];
}
const key = new PluginKey<Preview[]>("folioPendingImages");
let serial = 0;

export function imagePreviewPlugin() {
  return new Plugin({
    key,
    state: {
      init: (): Preview[] => [],
      apply(tr, previous) {
        const action: PreviewAction | undefined = tr.getMeta(key);
        if (action?.rebased) return action.rebased;
        const committed = action?.remove && previous.find((item) => item.id === action.remove);
        const placement: { before: number; after: number } | undefined = tr.getMeta("folioImagePlacement");
        // Fitting a block can remove the entire empty paragraph. Other pastes
        // at its caret sit either side of the actual inserted nodes, in paste order.
        const alongside =
          committed && placement
            ? previous.filter((item) => item.id !== committed.id && item.from === item.to && item.from === committed.to)
            : [];
        let next = action?.remove ? previous.filter((item) => item.id !== action.remove) : previous;
        if (alongside.length) next = next.filter((item) => !alongside.includes(item));
        for (const step of tr.mapping.maps) {
          if (!next.length) break;
          const changes: ChangedRange[] = [];
          step.forEach((fromA, toA, fromB, toB) => changes.push({ fromA, toA, fromB, toB }));
          next = next.flatMap((item) => {
            const range = mapImageRange(item, changes, item.id > (action?.remove ?? Infinity));
            return range ? [{ ...item, ...range }] : [];
          });
        }
        if (committed && placement)
          for (const item of alongside) {
            const pos = item.id > committed.id ? placement.after : placement.before;
            next.push({ ...item, from: pos, to: pos });
          }
        return action?.add ? [...next, action.add] : next;
      },
    },
    props: {
      decorations(state) {
        const pending = key.getState(state);
        if (!pending?.length) return null;
        return DecorationSet.create(
          state.doc,
          pending.map(({ id, from, dom }) =>
            Decoration.widget(from, dom, { key: `image-${id}`, side: -1, ignoreSelection: true }),
          ),
        );
      },
    },
  });
}

export function rebaseImagePreviews(
  tr: Transaction,
  view: EditorView,
  source: string,
  parts: FrontMatterParts,
  ast: Root,
) {
  const pending = key.getState(view.state);
  if (!pending?.length) return tr;
  let map: ReturnType<typeof sourcePositionMap> | undefined;
  const rebased = pending.flatMap((preview) => {
    const remote = preview.remote();
    if (!remote || remote.text !== source || !remote.range || remote.range.from < parts.bodyStart) return [];
    const positions = (map ??= sourcePositionMap(ast, parts.body, tr.doc));
    const pos = (offset: number) =>
      Math.max(0, Math.min(tr.doc.content.size, documentOffset(positions, offset - parts.bodyStart)));
    return [{ ...preview, from: pos(remote.range.from), to: pos(remote.range.to) }];
  });
  return tr.setMeta(key, { rebased });
}

// A canvas can render local bytes under img-src 'self'. No file URL is created,
// inserted into a node, copied to the clipboard, or sent to another participant.
function preview(files: File[]) {
  const dom = document.createElement("span");
  dom.className = "folio-pending-image";
  dom.contentEditable = "false";
  dom.setAttribute("role", "img");
  dom.setAttribute("aria-label", "Uploading image");
  for (const file of files) {
    const canvas = document.createElement("canvas");
    canvas.width = 96;
    canvas.height = 64;
    dom.append(canvas);
    if (typeof createImageBitmap === "function")
      void createImageBitmap(file)
        .then((bitmap) => {
          try {
            const scale = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height);
            const width = bitmap.width * scale;
            const height = bitmap.height * scale;
            canvas
              .getContext("2d")
              ?.drawImage(bitmap, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
          } finally {
            bitmap.close();
          }
        })
        .catch(() => {
          /* Keep the upload indicator when the local decoder is unavailable. */
        });
  }
  dom.append(document.createTextNode("Saving image…"));
  return dom;
}

export function captureImagePreview(
  session: ReadyEditorSession,
  files: File[],
  block: boolean,
  active: () => boolean,
): ImageBookmark {
  const { view } = session;
  flushDeferredInput();
  syncViewSelection(view);
  const { doc, selection } = view.state;
  const id = ++serial;
  const { from, to } = selection;
  const asBlock = block || !selection.$from.parent.content.size;
  const lookup = () => !view.isDestroyed && key.getState(view.state)?.find((item) => item.id === id);
  let rebased: ReturnType<Preview["remote"]> = null;
  const tr = closeHistory(view.state.tr).setMeta(key, {
    add: { from, to, id, dom: preview(files), remote: () => rebased },
  });
  if (!selection.empty) tr.setSelection(imageBoundarySelection(doc, to));
  view.dispatch(tr);
  return {
    cancel() {
      if (lookup()) view.dispatch(view.state.tr.setMeta(key, { remove: id }));
    },
    canCancel(undo) {
      flushDeferredInput();
      const item = lookup();
      return Boolean(
        item && (undo ? view.state.doc.eq(doc) : view.state.selection.empty && item.to === view.state.selection.from),
      );
    },
    beforeRemote(changes, text) {
      const item = lookup();
      if (!item) return;
      const map = sessionPositionMap(session, view);
      const a = sourceOffset(map, item.from),
        b = sourceOffset(map, item.to);
      const start = session.parts.bodyStart;
      // Empty Live paragraphs may have no distinct address in shared Markdown.
      // Do not silently move the image to a neighbouring block on reparse.
      const exact = documentOffset(map, a) === item.from && documentOffset(map, b) === item.to;
      rebased = { text, range: exact ? mapImageRange({ from: start + a, to: start + b }, changes) : null };
    },
    insert(urls) {
      if (!active() || view.isDestroyed || view.composing) return false;
      flushDeferredInput();
      if (view.hasFocus()) syncViewSelection(view);
      const item = lookup();
      if (!item) return false;
      const state = view.state;
      if (!doc.slice(from, to).eq(state.doc.slice(item.from, item.to))) return false;
      if (item.from < state.selection.to && item.to > state.selection.from && item.from !== item.to) return false;
      const target =
        selection instanceof NodeSelection
          ? NodeSelection.create(state.doc, item.from)
          : item.from === item.to
            ? imageBoundarySelection(state.doc, item.from)
            : TextSelection.between(state.doc.resolve(item.from), state.doc.resolve(item.to));
      if (!target.empty && (target.from !== item.from || target.to !== item.to)) return false;
      const transaction = imageInsertionTransaction(state, {
        images: urls.map((src) => state.schema.nodes.image.create({ src, alt: "Image" })),
        selection: target,
        block: asBlock,
        background: true,
      });
      view.dispatch(transaction.setMeta(key, { remove: id }));
      view.dispatch(closeHistory(view.state.tr));
      return true;
    },
  };
}
