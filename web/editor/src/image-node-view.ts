import { NodeSelection } from "@milkdown/prose/state";
import type { Node as ProseNode } from "@milkdown/prose/model";
import type { NodeViewConstructor } from "@milkdown/prose/view";
import { resolveMarkdownUrl } from "./editor-helpers.ts";
import { imageAttributes } from "./image-syntax.ts";
import {
  imageLayoutTransaction,
  imageRemovalTransaction,
  imageRowNeighbor,
  imageRowTransaction,
  isImageNode,
  type ImageNode,
  type ImageNodeAttrs,
} from "./image-model.ts";
import { focusEditorView } from "./cursor-coordinates.ts";
import { createNodeToolbar, toolButton } from "./node-toolbar.ts";
import type { MarkdownUrl, NodeActivity } from "./types/editor.ts";

interface ImageReplacement {
  valid_fn: () => boolean;
  replace_fn: (src: string) => boolean;
}

export interface ImageToolHandle extends NodeActivity {
  attributes_fn: () => ImageNodeAttrs;
  image_fn: () => HTMLImageElement | null;
  anchor_fn: () => HTMLElement;
  selected_fn: () => boolean;
  markdown_fn: () => string;
  focus_fn: () => void;
  select_fn: () => void;
  update_fn: (attrs: Partial<ImageNodeAttrs>) => void;
  reset_fn: () => void;
  rowAvailable_fn: () => boolean;
  row_fn: () => void;
  remove_fn: () => void;
  captureReplacement_fn: () => ImageReplacement;
}

export interface ImageViewOptions extends NodeActivity {
  path: string;
  transformUrl: MarkdownUrl;
  serialize_fn: (node: ProseNode) => string;
}

interface PanelState {
  open: boolean;
  custom: boolean;
}

interface ImageControls {
  root: HTMLElement;
  hover: ReturnType<typeof createNodeToolbar<ImageToolHandle>>;
  context_fn: () => number;
  panel_fn: () => PanelState;
  restorePanel_fn: (state: PanelState) => void;
  run_fn: (action: () => unknown | Promise<unknown>) => Promise<void>;
}

interface ImageDrag {
  id: number;
  x: number;
  width: number;
  ratio: number;
  limit: number;
  scale: number;
  next?: number;
}

export function createImageNodeView(
  { active_fn, editable_fn, path, transformUrl, serialize_fn }: ImageViewOptions,
  { root, hover, context_fn, panel_fn, restorePanel_fn, run_fn }: ImageControls,
): NodeViewConstructor {
  return (initial, view, getPos) => {
    if (!isImageNode(initial)) throw new Error("The image view requires an image node.");
    let node: ImageNode = initial;
    let drag: ImageDrag | null = null;
    const dom = document.createElement(node.isBlock ? "div" : "span");
    dom.className = `folio-inline-image${node.isBlock ? " folio-block-image" : ""}`;
    dom.dataset.imageNode = node.isBlock ? "block" : "inline";
    dom.contentEditable = "false";
    const image = document.createElement("img");
    image.loading = "lazy";
    image.draggable = false;
    const unavailable = document.createElement("span");
    const resizes = ["end", "start"].map((side) => {
      const button = toolButton({ label: side === "end" ? "Resize image" : "Resize image from left", onClick() {} });
      button.className = "folio-image-resize";
      button.dataset.resizeSide = side;
      button.tabIndex = -1;
      button.contentEditable = "false";
      return button;
    });
    dom.append(image, unavailable, ...resizes);
    const current = () => {
      const position = getPos();
      return active_fn() && typeof position === "number" && view.state.doc.nodeAt(position)?.eq(node) === true;
    };
    const position = () => {
      const value = getPos();
      if (typeof value !== "number") throw new Error("This image is no longer in the document.");
      return value;
    };
    const update = () => {
      const attrs = imageAttributes(node.attrs);
      dom.dataset.layout = attrs.layout;
      dom.style.width = attrs.width ? (attrs.width.endsWith("%") ? attrs.width : `${attrs.width}px`) : "";
      image.style.width = attrs.width ? "100%" : "";
      image.style.height = attrs.height ? (attrs.height.endsWith("%") ? attrs.height : `${attrs.height}px`) : "";
      image.alt = node.attrs.alt ?? "";
      image.title = node.attrs.title ?? "";
      const url = resolveMarkdownUrl(node.attrs.src, path, true);
      const resolved = url && transformUrl(url, path);
      image.hidden = !url;
      unavailable.hidden = Boolean(url);
      for (const resize of resizes) resize.hidden = !url;
      if (url) {
        image.dataset.noteUrl = url;
        if (resolved) {
          if (image.getAttribute("src") !== resolved) image.src = resolved;
        } else image.removeAttribute("src");
      } else {
        image.removeAttribute("src");
        delete image.dataset.noteUrl;
        unavailable.textContent = `Image: ${node.attrs.alt || node.attrs.src || "unavailable"} (external or unsafe image not loaded)`;
      }
    };
    const change = (attrs: Partial<ImageNodeAttrs>, { preserveSelection = false } = {}) => {
      if (!current() || !editable_fn()) throw new Error("This image is no longer editable.");
      const panel = panel_fn();
      const previousSelection = view.state.selection;
      const transaction = imageLayoutTransaction(view.state, { position: position(), attrs });
      if (preserveSelection) transaction.setSelection(previousSelection.map(transaction.doc, transaction.mapping));
      view.dispatch(transaction);
      if (!preserveSelection) {
        view.focus();
        const anchor = view.nodeDOM(transaction.selection.from);
        if (anchor instanceof HTMLElement) hover.open(anchor);
        restorePanel_fn(panel);
      }
    };
    const unregister = hover.register(dom, {
      active_fn: current,
      editable_fn,
      attributes_fn: () => node.attrs,
      image_fn: () => (image.hidden ? null : image),
      anchor_fn: () => dom,
      selected_fn: () => view.state.selection instanceof NodeSelection && view.state.selection.from === getPos(),
      markdown_fn: () => serialize_fn(node),
      focus_fn: () => focusEditorView(view),
      select_fn() {
        if (current()) view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, position())));
      },
      update_fn: change,
      reset_fn() {
        change({
          width: null,
          height: null,
          layout: node.isBlock ? "left" : "inline",
          explicitInline: node.isInline && node.attrs.explicitInline,
        });
      },
      rowAvailable_fn: () => current() && Boolean(imageRowNeighbor(view.state.doc, position())),
      row_fn() {
        if (!current() || !editable_fn()) throw new Error("This image is no longer editable.");
        const neighbor = imageRowNeighbor(view.state.doc, position());
        const transaction = neighbor && imageRowTransaction(view.state, neighbor);
        if (!transaction)
          throw new Error("Place two image blocks next to each other before arranging them side by side.");
        view.dispatch(transaction);
        view.focus();
      },
      remove_fn() {
        if (!current() || !editable_fn()) throw new Error("This image is no longer editable.");
        const transaction = imageRemovalTransaction(view.state, position());
        if (!transaction) throw new Error("This image is no longer in the document.");
        view.dispatch(transaction);
        view.focus();
      },
      captureReplacement_fn() {
        if (!current() || !editable_fn()) throw new Error("This image is no longer editable.");
        const previous = node;
        const version = context_fn();
        const valid_fn = () => version === context_fn() && current() && editable_fn() && node.eq(previous);
        return {
          valid_fn,
          replace_fn(src) {
            if (!valid_fn()) return false;
            change({ src }, { preserveSelection: true });
            return true;
          },
        };
      },
    });
    const finish = (event: PointerEvent) => {
      if (!drag || drag.id !== event.pointerId) return;
      const previous = drag;
      const next = previous.next;
      drag = null;
      update();
      if (event.type === "pointerup" && next)
        void run_fn(() =>
          change({
            width: String(next),
            height: node.attrs.height ? String(Math.max(1, Math.round(next * previous.ratio))) : null,
          }),
        );
    };
    for (const resize of resizes) {
      resize.addEventListener("pointerdown", (event) => {
        if (!current() || !editable_fn() || event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, position())));
        view.focus();
        const bounds = image.getBoundingClientRect();
        drag = {
          id: event.pointerId,
          x: event.clientX,
          width: bounds.width,
          ratio: bounds.height / bounds.width,
          limit: view.dom.clientWidth,
          scale: (resize.dataset.resizeSide === "start" ? -1 : 1) * (node.attrs.layout === "center" ? 2 : 1),
        };
        resize.setPointerCapture(event.pointerId);
      });
      resize.addEventListener("pointermove", (event) => {
        if (!drag || drag.id !== event.pointerId) return;
        drag.next = Math.max(
          16,
          Math.min(16384, drag.limit, Math.round(drag.width + (event.clientX - drag.x) * drag.scale)),
        );
        dom.style.width = `${drag.next}px`;
        image.style.width = "100%";
        image.style.height = node.attrs.height ? `${Math.round(drag.next * drag.ratio)}px` : "";
        hover.position();
      });
      resize.addEventListener("pointerup", finish);
      resize.addEventListener("pointercancel", finish);
    }
    dom.addEventListener("dragstart", (event) => {
      if (!image.getAttribute("src")) {
        event.preventDefault();
        return;
      }
      if (!current() || !editable_fn()) return;
      root.dataset.imageDragging = "true";
      dom.classList.add("is-dragging");
      hover.close();
    });
    dom.addEventListener("dragend", () => {
      delete root.dataset.imageDragging;
      dom.classList.remove("is-dragging");
    });
    update();
    return {
      dom,
      destroy: unregister,
      update(next) {
        if (next.type !== node.type || !isImageNode(next)) return false;
        node = next;
        update();
        return true;
      },
      stopEvent: (event) => {
        const target = event.target;
        return (
          event.type !== "drop" &&
          !event.type.startsWith("drag") &&
          target instanceof Node &&
          resizes.some((resize) => resize.contains(target))
        );
      },
      ignoreMutation: (mutation) => mutation.type !== "selection",
    };
  };
}
