import { Compartment, EditorSelection, EditorState, Transaction, type Text } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab, isolateHistory, selectLine } from "@codemirror/commands";
import "./source-editor.css";
import { textareaCursorRect, textareaOffsetAtPoint } from "./cursor-coordinates.ts";
import { shouldVirtualizeSource } from "./editor-helpers.ts";
import { createNativeSourceHistory } from "./native-source-history.ts";
import type { Command } from "@codemirror/view";
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
  host.className = "virtual-source-editor";
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
  const insertLineAbove: Command = ({ state, dispatch }) => {
    if (state.readOnly) return false;
    dispatch(
      state.update(
        state.changeByRange((range) => {
          const line = state.doc.lineAt(range.from);
          const indent = line.text.match(/^[ \t]*/)?.[0] ?? "";
          return {
            changes: { from: line.from, insert: indent + state.lineBreak },
            range: EditorSelection.cursor(line.from + indent.length),
          };
        }),
        { scrollIntoView: true, userEvent: "input", annotations: isolateHistory.of("full") },
      ),
    );
    return true;
  };

  const value = () => {
    if (!view) return textarea.value;
    if (cachedDocument !== view.state.doc) {
      cachedDocument = view.state.doc;
      cachedValue = view.state.doc.toString();
    }
    return cachedValue;
  };

  const emitInput = (changes?: SourceChanges) =>
    textarea.dispatchEvent(changes ? new CustomEvent("input", { detail: { changes } }) : new Event("input"));
  const nativeHistory = createNativeSourceHistory({
    textarea,
    active_fn: () => !view,
    editable_fn: () => !disabled && !readOnly,
    emit_fn: emitInput,
    onNotice,
  });
  const createView = (text: string) => {
    pane.classList.add("is-virtual-source");
    textarea.hidden = true;
    textarea.value = "";
    host.hidden = false;
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: text,
        extensions: [
          history(),
          EditorState.transactionExtender.of((transaction) =>
            ["delete.line", "move.line", "input.copyline"].some((event) => transaction.isUserEvent(event))
              ? { annotations: isolateHistory.of("full") }
              : null,
          ),
          keymap.of([
            { key: "Mod-Shift-Enter", run: insertLineAbove, preventDefault: true },
            { key: "Mod-l", run: selectLine, preventDefault: true },
            ...defaultKeymap,
            ...historyKeymap,
            indentWithTab,
          ]),
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

  const setValue = (text: string, reset = false) => {
    text = String(text);
    if (reset && view) destroyView("");
    if (!view) {
      if (!reset && textarea.value === text) return;
      textarea.value = text;
      nativeHistory.reset(textarea.value);
      invalidateVirtualSize();
      return;
    }
    if (value() === text) return;
    syncing = true;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      annotations: Transaction.addToHistory.of(false),
    });
    syncing = false;
    cachedDocument = view.state.doc;
    cachedValue = text;
  };

  return {
    get value() {
      return value();
    },
    set value(text: string) {
      setValue(text);
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
      return view ? view.scrollDOM.scrollTop : textarea.scrollTop;
    },
    set scrollTop(value: number) {
      if (view) view.scrollDOM.scrollTop = value;
      else textarea.scrollTop = value;
    },
    get selectionStart() {
      return view ? view.state.selection.main.head : textarea.selectionStart;
    },
    getSelection() {
      return view
        ? { from: view.state.selection.main.anchor, to: view.state.selection.main.head }
        : { from: textarea.selectionStart, to: textarea.selectionEnd };
    },
    cursorRect(position: number) {
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
      if (disabled || readOnly) throw new Error("The source editor is read-only.");
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
      } else textarea.setSelectionRange(from, to);
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
      textarea.removeEventListener("input", invalidateVirtualSize);
      nativeHistory.destroy();
      destroyView("");
      host.remove();
    },
  };
}
