import { Compartment, EditorSelection, EditorState, Transaction, type Text, type ChangeDesc } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, historyField, isolateHistory, undo, redo } from "@codemirror/commands";
import { sourceCommands } from "./source-commands.ts";
import "./source-editor.css";
import { textareaCursorRect, textareaOffsetAtPoint } from "./cursor-coordinates.ts";
import { shouldVirtualizeSource } from "./editor-helpers.ts";
import { createNativeSourceHistory } from "./native-source-history.ts";
import { liveTransaction, markdownHistory, type HistoryCommand, type LiveEdit } from "./markdown-history.ts";
import { mapImageRange, type ImageBookmark } from "./image-bookmarks.ts";
import type { ChangedRange, SourceChanges, SourceEditorOptions } from "./types/editor.ts";

const VIRTUAL_SOURCE_THRESHOLD = 768 * 1024;

export function createSourceEditor({
  textarea,
  nonce,
  threshold = VIRTUAL_SOURCE_THRESHOLD,
  onNotice = (message) => console.error(message),
}: SourceEditorOptions) {
  const pane = textarea.parentElement;
  if (!pane) throw new Error("The source editor needs a textarea inside its workspace.");
  const host = document.createElement("div");
  host.className = "virtual-source-editor folio-source-surface";
  host.hidden = true;
  textarea.after(host);
  const editable = new Compartment();
  const wrapping = new Compartment();
  let view: EditorView | null = null;
  let lineWrapping = true;
  let disabled = textarea.disabled;
  let readOnly = false;
  const editability = () => [
    EditorView.editable.of(!disabled && !readOnly),
    EditorState.readOnly.of(disabled || readOnly),
  ];
  let syncing = false;
  let cachedDocument: Text | null = null;
  let cachedValue = "";
  let virtualSize: boolean | null = null;

  const invalidateVirtualSize = () => {
    virtualSize = null;
  };
  textarea.addEventListener("input", invalidateVirtualSize);
  // The Live editor mirrors every keystroke into this hidden textarea. For a large note that write costs
  // milliseconds per key, so the newest text waits here and reaches the DOM once typing pauses or the
  // textarea is about to be used.
  const DEFERRED_WRITE_LENGTH = 200_000;
  let pending: string | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  const sync = () => {
    if (pendingTimer !== null) clearTimeout(pendingTimer);
    pendingTimer = null;
    if (pending === null) return;
    const text = pending;
    pending = null;
    textarea.value = text;
  };
  for (const type of ["focus", "pointerdown", "keydown", "beforeinput"]) textarea.addEventListener(type, sync, true);

  const value = () => {
    if (!view) return pending ?? textarea.value;
    if (cachedDocument !== view.state.doc) {
      cachedDocument = view.state.doc;
      cachedValue = view.state.doc.toString();
    }
    return cachedValue;
  };

  const emitInput = (changes?: SourceChanges) =>
    textarea.dispatchEvent(changes ? new CustomEvent("input", { detail: { changes } }) : new Event("input"));
  const bookmarks = new Map<number, { from: number; to: number }>();
  const remoteRanges = new Map<number, { text: string; range: { from: number; to: number } | null }>();
  let serial = 0;
  let inserting = Infinity;
  const mapRanges = (ranges: ChangedRange[]) => {
    for (const [id, range] of bookmarks) {
      const next = mapImageRange(range, ranges, id > inserting);
      if (next) bookmarks.set(id, next);
      else bookmarks.delete(id);
    }
  };
  const mapImages = (changes: ChangeDesc) => {
    if (!bookmarks.size) return;
    const ranges: ChangedRange[] = [];
    changes.iterChangedRanges((fromA, toA, fromB, toB) => ranges.push({ fromA, toA, fromB, toB }));
    mapRanges(ranges);
  };
  const nativeHistory = createNativeSourceHistory({
    textarea,
    active_fn: () => !view && pending === null,
    editable_fn: () => !disabled && !readOnly,
    emit_fn: emitInput,
    mapImages,
    onNotice,
  });
  const createView = (text: string) => {
    pending = null;
    pane.classList.add("is-virtual-source");
    textarea.hidden = true;
    textarea.value = "";
    host.hidden = false;
    const previous = nativeHistory.state;
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: text,
        extensions: [
          history(),
          ...(previous ? [historyField.init(() => previous.field(historyField))] : []),
          sourceCommands,
          EditorState.tabSize.of(4),
          wrapping.of(lineWrapping ? EditorView.lineWrapping : []),
          EditorView.cspNonce.of(nonce ?? ""),
          EditorView.contentAttributes.of({
            "aria-label": "Markdown source",
            "aria-multiline": "true",
            "aria-describedby": textarea.getAttribute("aria-describedby") ?? "",
            "aria-invalid": textarea.getAttribute("aria-invalid") ?? "false",
            autocomplete: "off",
            autocapitalize: "off",
            spellcheck: "false",
          }),
          editable.of(editability()),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !syncing) {
              mapImages(update.changes);
              cachedDocument = null;
              const ranges: ChangedRange[] = [];
              update.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
                ranges.push({ fromA, toA, fromB, toB });
              });
              emitInput({
                ranges,
                beforeLength: update.startState.doc.length,
                afterLength: update.state.doc.length,
              });
            }
          }),
        ],
      }),
    });
    cachedDocument = view.state.doc;
    cachedValue = text;
    nativeHistory.reset("");
  };

  const destroyView = (text = value()) => {
    view?.destroy();
    view = null;
    cachedDocument = null;
    cachedValue = "";
    host.replaceChildren();
    host.hidden = true;
    textarea.hidden = false;
    textarea.value = text;
    nativeHistory.reset(textarea.value);
    invalidateVirtualSize();
    pane.classList.remove("is-virtual-source");
  };

  const setValue = (text: string, reset = false, live?: LiveEdit) => {
    text = String(text);
    if (reset) {
      bookmarks.clear();
      remoteRanges.clear();
    }
    // Collaboration (or a save normalization) supplies text, not a CM transaction.
    if (bookmarks.size && value() !== text) {
      const previous = value();
      let start = 0,
        a = previous.length,
        b = text.length;
      while (start < a && start < b && previous[start] === text[start]) start++;
      while (a > start && b > start && previous[a - 1] === text[b - 1]) {
        a--;
        b--;
      }
      mapRanges([{ fromA: start, toA: a, fromB: start, toB: b }]);
      // Identical runs of text are ambiguous to a diff. For a shared edit use
      // the actual Y.Text delta, including separate changes on either side.
      for (const [id, rebased] of remoteRanges) {
        if (rebased.text === text) {
          if (rebased.range) bookmarks.set(id, rebased.range);
          else bookmarks.delete(id);
        }
      }
      remoteRanges.clear();
    }
    if (reset && view) destroyView("");
    if (!view) {
      if (!reset && value() === text) return;
      invalidateVirtualSize();
      // A textarea normalizes line endings, so only text it would store unchanged may wait.
      if (!reset && text.length >= DEFERRED_WRITE_LENGTH && !text.includes("\r")) {
        if (live) nativeHistory.live(text, live);
        else nativeHistory.reset(text);
        pending = text;
        if (pendingTimer !== null) clearTimeout(pendingTimer);
        pendingTimer = setTimeout(sync, 250);
        return;
      }
      pending = null;
      textarea.value = text;
      if (live) nativeHistory.live(textarea.value, live);
      else nativeHistory.reset(textarea.value);
      return;
    }
    const previous = value();
    if (previous === text) return;
    if (live) {
      syncing = true;
      try {
        view.dispatch(liveTransaction(view.state, previous, text, live));
      } finally {
        syncing = false;
      }
      cachedDocument = view.state.doc;
      cachedValue = text;
      return;
    }
    let from = 0;
    let to = view.state.doc.length;
    let end = text.length;
    if (to === previous.length) {
      while (from < to && from < end && previous.charCodeAt(from) === text.charCodeAt(from)) from++;
      while (to > from && end > from && previous.charCodeAt(to - 1) === text.charCodeAt(end - 1)) {
        to--;
        end--;
      }
    }
    syncing = true;
    try {
      view.dispatch({
        changes: { from, to, insert: text.slice(from, end) },
        annotations: Transaction.addToHistory.of(false),
      });
    } finally {
      syncing = false;
    }
    cachedDocument = view.state.doc;
    cachedValue = text;
  };

  return {
    captureImageInsertion(): ImageBookmark | null {
      if (disabled || readOnly) return null;
      sync();
      const original = value();
      const id = ++serial;
      const { from: a, to: b } = this.getSelection();
      const from = Math.min(a, b),
        to = Math.max(a, b);
      bookmarks.set(id, { from, to });
      if (from !== to) this.setSelectionRange(to, to);
      return {
        cancel: () => {
          bookmarks.delete(id);
          remoteRanges.delete(id);
        },
        beforeRemote: (changes, text) => {
          const range = bookmarks.get(id);
          if (range) remoteRanges.set(id, { text, range: mapImageRange(range, changes) });
        },
        canCancel: (undo) => {
          const range = bookmarks.get(id);
          const sel = this.getSelection();
          return Boolean(range && (undo ? value() === original : sel.from === sel.to && sel.to === range.to));
        },
        insert: (urls) => {
          sync();
          const range = bookmarks.get(id);
          if (!range || disabled || readOnly || original.slice(from, to) !== value().slice(range.from, range.to))
            return false;
          const current = this.getSelection();
          if (
            range.from !== range.to &&
            range.from < Math.max(current.from, current.to) &&
            range.to > Math.min(current.from, current.to)
          )
            return false;
          bookmarks.delete(id);
          inserting = id;
          try {
            const insert = urls.map((url) => `![Image](${url})`).join("\n");
            if (view) {
              const changes = view.state.changes({ ...range, insert });
              view.dispatch({
                changes,
                selection: view.state.selection.map(changes, 1),
                annotations: isolateHistory.of("full"),
                userEvent: "input.paste",
              });
            } else nativeHistory.insertImage(range.from, range.to, insert);
          } finally {
            inserting = Infinity;
          }
          return true;
        },
      };
    },
    get value() {
      return value();
    },
    set value(text: string) {
      setValue(text);
    },
    mirrorLive(text: string, edit: LiveEdit) {
      setValue(text, false, edit);
    },
    historyState() {
      const state = view?.state ?? nativeHistory.state;
      return state ? markdownHistory(state) : null;
    },
    runHistory(kind: HistoryCommand) {
      if (disabled || readOnly) return false;
      sync();
      return view ? (kind === "undo" ? undo : redo)(view) : nativeHistory.runHistory(kind);
    },
    applyDiskChange(change: { from: number; to: number; insert: string }, next: string) {
      sync();
      if (view) {
        syncing = true;
        try {
          view.dispatch({ changes: change, annotations: Transaction.addToHistory.of(false) });
        } finally {
          syncing = false;
        }
        cachedDocument = view.state.doc;
        cachedValue = next;
      } else {
        nativeHistory.applyRemote(change, next);
        invalidateVirtualSize();
      }
    },
    get disabled() {
      return disabled;
    },
    set disabled(value: boolean) {
      const next = Boolean(value);
      if (next === disabled) return;
      disabled = next;
      textarea.disabled = disabled;
      if (view) {
        view.dispatch({ effects: editable.reconfigure(editability()) });
      }
    },
    setReadOnly(value: boolean) {
      if (readOnly === Boolean(value)) return;
      readOnly = Boolean(value);
      textarea.readOnly = readOnly;
      if (view) view.dispatch({ effects: editable.reconfigure(editability()) });
    },
    get scrollTop() {
      sync();
      return view ? view.scrollDOM.scrollTop : textarea.scrollTop;
    },
    set scrollTop(value: number) {
      sync();
      if (view) view.scrollDOM.scrollTop = value;
      else textarea.scrollTop = value;
    },
    get selectionStart() {
      sync();
      return view ? view.state.selection.main.head : textarea.selectionStart;
    },
    getSelection() {
      sync();
      return view
        ? { from: view.state.selection.main.anchor, to: view.state.selection.main.head }
        : textarea.selectionDirection === "backward"
          ? { from: textarea.selectionEnd, to: textarea.selectionStart }
          : { from: textarea.selectionStart, to: textarea.selectionEnd };
    },
    cursorRect(position: number) {
      sync();
      return view
        ? view.coordsAtPos(Math.max(0, Math.min(view.state.doc.length, position)))
        : textareaCursorRect(textarea, position);
    },
    viewportRect() {
      return (view?.scrollDOM ?? textarea).getBoundingClientRect();
    },
    get lineHeight() {
      return Number.parseFloat(getComputedStyle(view?.contentDOM ?? textarea).lineHeight);
    },
    reset(text: string) {
      setValue(text, true);
    },
    applyEdit(text: string) {
      if (disabled || readOnly) throw new Error("Read-only");
      sync();
      if (value() === text) return;
      if (!view && shouldVirtualizeSource(text, threshold)) createView(value());
      if (view)
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          selection: EditorSelection.cursor(text.length),
          annotations: isolateHistory.of("full"),
          userEvent: "input.recovery",
        });
      else nativeHistory.replace(text);
    },
    prepare() {
      sync();
      if (view) return;
      virtualSize ??= shouldVirtualizeSource(textarea.value, threshold);
      if (virtualSize) createView(textarea.value);
    },
    focus(options?: FocusOptions) {
      this.prepare();
      if (view) view.contentDOM.focus(options);
      else textarea.focus(options);
    },
    select() {
      sync();
      if (view) {
        view.dispatch({
          selection: EditorSelection.range(0, view.state.doc.length),
          scrollIntoView: true,
        });
      } else textarea.select();
    },
    setSelectionRange(from: number, to: number) {
      this.prepare();
      if (view) {
        const length = view.state.doc.length;
        view.dispatch({
          selection: EditorSelection.range(Math.max(0, Math.min(length, from)), Math.max(0, Math.min(length, to))),
        });
      } else textarea.setSelectionRange(Math.min(from, to), Math.max(from, to), from > to ? "backward" : "forward");
    },
    revealSelection(from: number, to: number, { focus = true } = {}) {
      this.prepare();
      this.setSelectionRange(from, to);
      if (focus) this.focus({ preventScroll: true });
      if (view) view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main, { y: "center" }) });
      else {
        const rect = textareaCursorRect(textarea, Math.min(from, to));
        if (rect) textarea.scrollTop += rect.top - textarea.getBoundingClientRect().top - textarea.clientHeight / 3;
      }
    },
    jumpTo(position: number) {
      this.prepare();
      if (view) {
        const at = Math.max(0, Math.min(view.state.doc.length, position));
        view.focus();
        view.dispatch({
          selection: { anchor: at },
          effects: EditorView.scrollIntoView(at, { y: "start", yMargin: view.defaultLineHeight * 3 }),
        });
        return;
      }
      const text = textarea.value;
      const at = Math.max(0, Math.min(text.length, position));
      if (!textarea.disabled) {
        // Native focus reveals the range using the browser's wrapped-line layout.
        if (textarea.ownerDocument.activeElement === textarea) textarea.blur();
        textarea.setSelectionRange(at, at);
        textarea.focus();
        return;
      }
      textarea.setSelectionRange(at, at);
      const rect = textareaCursorRect(textarea, at);
      if (rect) textarea.scrollTop += rect.top - textarea.getBoundingClientRect().top - this.lineHeight * 3;
    },
    selectAtPoint(x: number, y: number) {
      this.prepare();
      const position = view ? view.posAtCoords({ x, y }) : textareaOffsetAtPoint(textarea, x, y);
      if (position === null) return false;
      this.setSelectionRange(position, position);
      this.focus();
      return true;
    },
    setAttribute(name: string, next: string) {
      textarea.setAttribute(name, next);
      view?.contentDOM.setAttribute(name, next);
    },
    setLineWrapping(value: boolean) {
      lineWrapping = Boolean(value);
      textarea.wrap = lineWrapping ? "soft" : "off";
      if (view) {
        view.dispatch({
          effects: wrapping.reconfigure(lineWrapping ? EditorView.lineWrapping : []),
        });
      }
    },
    setThreshold(bytes: number) {
      threshold = Math.max(256 * 1024, Number(bytes) || VIRTUAL_SOURCE_THRESHOLD);
      invalidateVirtualSize();
    },
    addEventListener: textarea.addEventListener.bind(textarea),
    dispatchEvent(event: Event) {
      return textarea.dispatchEvent(event);
    },
    isVirtual() {
      return Boolean(view);
    },
    destroy() {
      sync();
      for (const type of ["focus", "pointerdown", "keydown", "beforeinput"])
        textarea.removeEventListener(type, sync, true);
      textarea.removeEventListener("input", invalidateVirtualSize);
      nativeHistory.destroy();
      destroyView("");
      host.remove();
    },
  };
}
