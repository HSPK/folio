import {
  turnIntoTextCommand,
  wrapInHeadingCommand,
  wrapInBulletListCommand,
  wrapInOrderedListCommand,
  wrapInBlockquoteCommand,
  createCodeBlockCommand,
  insertHrCommand,
} from "@milkdown/preset-commonmark";
import { insertTableCommand } from "@milkdown/preset-gfm";
import { commandsCtx, type Editor } from "@milkdown/core";
import { Plugin, Selection, TextSelection, type Command, type EditorState } from "@milkdown/prose/state";
import { Decoration, DecorationSet, EditorView } from "@milkdown/prose/view";
import { $prose, type $Command } from "@milkdown/utils";
import { setBlockType } from "@milkdown/prose/commands";
import { closeHistory } from "@milkdown/prose/history";
import { createIcon } from "./icons.ts";
import { imageInsertionTransaction } from "./image-model.ts";
import { isReadySession } from "./editor-session.ts";
import { errorMessage } from "./errors.ts";
import type { EditorSession, InlineEditorOptions, ReadyEditorSession, TextSelectionRange } from "./types/editor.ts";
import type { Lifetime } from "../../shared/lifetime.ts";
type SlashItem = {
  title: string;
  icon: string;
} & (
  | {
      kind: "image";
    }
  | {
      kind: "command";
      execute: (editor: Editor, state: EditorState) => Command;
      task?: boolean;
    }
);
function command<Payload>(value: $Command<Payload>, payload?: Payload) {
  return (editor: Editor) => editor.action((ctx) => ctx.get(commandsCtx).get(value.key)(payload));
}
const commands: SlashItem[] = [
  { title: "Text", icon: "text", kind: "command", execute: command(turnIntoTextCommand) },
  { title: "Heading 1", icon: "heading-1", kind: "command", execute: command(wrapInHeadingCommand, 1) },
  { title: "Heading 2", icon: "heading-2", kind: "command", execute: command(wrapInHeadingCommand, 2) },
  { title: "Heading 3", icon: "heading-3", kind: "command", execute: command(wrapInHeadingCommand, 3) },
  { title: "Bullet list", icon: "list", kind: "command", execute: command(wrapInBulletListCommand) },
  { title: "Numbered list", icon: "list-ordered", kind: "command", execute: command(wrapInOrderedListCommand) },
  { title: "Task list", icon: "circle-check", kind: "command", execute: command(wrapInBulletListCommand), task: true },
  { title: "Quote", icon: "quote", kind: "command", execute: command(wrapInBlockquoteCommand) },
  { title: "Code block", icon: "code", kind: "command", execute: command(createCodeBlockCommand) },
  { title: "Table", icon: "table", kind: "command", execute: command(insertTableCommand, { row: 3, col: 3 }) },
  { title: "Image", icon: "image", kind: "image" },
  {
    title: "Formula",
    icon: "code",
    kind: "command",
    execute: (_editor, state) => setBlockType(state.schema.nodes.math_block),
  },
  { title: "Divider", icon: "minus", kind: "command", execute: command(insertHrCommand) },
];
function slashQuery(selection: Selection) {
  const { $from } = selection;
  if (
    !selection.empty ||
    $from.parent.type.name !== "paragraph" ||
    $from.parentOffset < 1 ||
    $from.parentOffset > 49 ||
    $from.parent.firstChild?.text?.[0] !== "/"
  )
    return null;
  const role = $from.depth > 0 ? $from.node(-1).type.spec.tableRole : undefined;
  if (role === "cell" || role === "header_cell") return null;
  const text = $from.parent.textBetween(0, $from.parentOffset, "", "\ufffc");
  return /^\/[^/\r\n]{0,48}$/.test(text) ? { from: $from.start(), to: selection.from, text } : null;
}
export function createSlashMenu(
  active: (state: EditorSession) => boolean,
  {
    lifetime,
    upload_fn,
    onNotice,
  }: {
    lifetime: Lifetime;
    upload_fn?: InlineEditorOptions["onImageUpload"];
    onNotice?: InlineEditorOptions["onNotice"];
  },
) {
  const menu = document.createElement("div");
  menu.id = "folio-slash-menu";
  menu.className = "folio-slash-menu";
  menu.hidden = true;
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", "Insert block");
  const heading = document.createElement("div");
  heading.className = "folio-slash-heading";
  heading.setAttribute("role", "presentation");
  heading.textContent = "Basic blocks";
  menu.append(heading);
  let owner: ReadyEditorSession | null = null;
  let selectedIndex = 0;
  let visible: number[] = [];
  let queryRange: TextSelectionRange | null = null;
  let dismissed: {
    state: EditorSession;
    from: number;
  } | null = null;
  let signature = "";
  let frame = 0;
  let placement: string | null = null;
  const empty = document.createElement("p");
  empty.className = "folio-slash-empty";
  empty.textContent = "No matching block. Keep typing as text, or press Escape.";
  empty.hidden = true;
  const file = document.createElement("input");
  file.type = "file";
  file.accept = "image/png,image/jpeg,image/gif,image/webp";
  file.hidden = true;
  let pendingImage: {
    state: ReadyEditorSession;
    range: TextSelectionRange;
    document: EditorState["doc"];
  } | null = null;
  lifetime.listen(file, "cancel", () => {
    pendingImage = null;
  });
  lifetime.listen(file, "change", async () => {
    const captured = pendingImage;
    pendingImage = null;
    if (!captured || !file.files?.length) return;
    let url = "";
    try {
      const { state, range, document } = captured;
      if (!active(state) || !state.view.editable || state.view.state.doc !== document)
        throw new Error("The insertion position changed.");
      if (!upload_fn) throw new Error("Image uploads are unavailable.");
      onNotice?.("Saving image…");
      url = await upload_fn(file.files[0]);
      if (!active(state) || !state.view.editable || state.view.state.doc !== document)
        throw new Error("The document changed while uploading.");
      const image = state.view.state.schema.nodes.image_block.create({ src: url, alt: "Image", layout: "left" });
      const selection = range ? TextSelection.create(document, range.from, range.to) : state.view.state.selection;
      state.view.dispatch(
        closeHistory(imageInsertionTransaction(state.view.state, { images: [image], selection, block: true })),
      );
      state.view.focus();
      onNotice?.("");
    } catch (error) {
      onNotice?.(
        `Could not insert image: ${errorMessage(error)}${url ? ` The saved image is available at ${url}.` : ""}`,
        "error",
      );
    } finally {
      file.value = "";
    }
  });
  const buttons = commands.map((item, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.id = `folio-slash-option-${index}`;
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", "false");
    const glyph = document.createElement("span");
    glyph.className = "folio-slash-glyph";
    glyph.append(createIcon(item.icon));
    glyph.setAttribute("aria-hidden", "true");
    const copy = document.createElement("span");
    copy.className = "folio-slash-copy";
    const title = document.createElement("strong");
    title.textContent = item.title;
    copy.append(title);
    button.append(glyph, copy);
    lifetime.listen(button, "mousedown", (event) => event.preventDefault());
    lifetime.listen(button, "pointermove", () => {
      const option = visible.indexOf(index);
      if (option >= 0 && option !== selectedIndex) select(option);
    });
    lifetime.listen(button, "click", () => run(visible.indexOf(index)));
    menu.append(button);
    return button;
  });
  menu.append(empty);
  document.body.append(menu, file);
  lifetime.defer(() => {
    close();
    pendingImage = null;
    menu.remove();
    file.remove();
  });
  function select(index: number) {
    if (!visible.length) return;
    selectedIndex = (index + visible.length) % visible.length;
    for (const [buttonIndex, button] of buttons.entries()) {
      const selected = buttonIndex === visible[selectedIndex];
      button.setAttribute("aria-selected", String(selected));
      button.toggleAttribute("data-active", selected);
    }
    owner?.view?.dom.setAttribute("aria-activedescendant", buttons[visible[selectedIndex]].id);
    const button = buttons[visible[selectedIndex]];
    const top = button.offsetTop;
    const bottom = top + button.offsetHeight;
    if (top < menu.scrollTop) menu.scrollTop = top;
    else if (bottom > menu.scrollTop + menu.clientHeight) menu.scrollTop = bottom - menu.clientHeight;
  }
  function close(dismiss = false) {
    if (menu.hidden && !owner) {
      if (!dismiss) dismissed = null;
      return;
    }
    const previous = owner;
    dismissed = dismiss && owner && queryRange ? { state: owner, from: queryRange.from } : null;
    owner?.view?.dom.removeAttribute("aria-controls");
    owner?.view?.dom.removeAttribute("aria-activedescendant");
    owner = null;
    queryRange = null;
    signature = "";
    placement = null;
    menu.style.removeProperty("max-height");
    menu.hidden = true;
    cancelAnimationFrame(frame);
    frame = 0;
    if (dismiss && previous?.ready && !previous.view.composing) {
      previous.view.dispatch(previous.view.state.tr.setMeta("addToHistory", false));
    }
  }
  function position() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (menu.hidden || !owner || !queryRange) return;
      const coordinates = owner.view.coordsAtPos(queryRange.from);
      const below = Math.max(0, window.innerHeight - 12 - coordinates.bottom - 8);
      const above = Math.max(0, coordinates.top - 8 - 12);
      if (placement === null) {
        const height = menu.getBoundingClientRect().height;
        placement = height <= below || below >= above ? "below" : "above";
      }
      menu.style.maxHeight = `${Math.min(352, placement === "below" ? below : above)}px`;
      const bounds = menu.getBoundingClientRect();
      const left = Math.min(Math.max(12, coordinates.left), window.innerWidth - bounds.width - 12);
      const top = placement === "above" ? Math.max(12, coordinates.top - bounds.height - 8) : coordinates.bottom + 8;
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
    });
  }
  function perform(item: SlashItem | undefined, state: EditorSession | null, range: TextSelectionRange | null) {
    close();
    if (!state || !item || !range || !active(state) || !isReadySession(state) || !state.view.editable) return;
    if (item.kind === "image") {
      pendingImage = { state, range, document: state.view.state.doc };
      file.value = "";
      file.click();
      return;
    }
    const tr = closeHistory(state.view.state.tr).delete(range.from, range.to);
    const prepared = state.view.state.apply(tr);
    const command = item.execute(state.editor, prepared);
    const accepted = command(prepared, (next) => {
      for (const step of next.steps) tr.step(step);
      tr.setSelection(Selection.fromJSON(tr.doc, next.selection.toJSON()));
    });
    if (!accepted && !item.task) {
      onNotice?.("This block cannot be inserted at the current position.", "warning");
      return;
    }
    if (item.task) {
      const { $from } = tr.selection;
      let found = false;
      for (let depth = $from.depth; depth > 0; depth--) {
        if ($from.node(depth).type.name !== "list_item") continue;
        tr.setNodeMarkup($from.before(depth), undefined, { ...$from.node(depth).attrs, checked: false });
        found = true;
        break;
      }
      if (!found) {
        onNotice?.("Place the cursor in a paragraph to create a task.", "warning");
        return;
      }
    }
    state.view.dispatch(tr);
    state.view.focus();
  }
  function run(index: number) {
    perform(commands[visible[index]], owner, queryRange);
  }
  lifetime.listen(document, "pointerdown", (event) => {
    if (!menu.hidden && event.target instanceof Node && !menu.contains(event.target)) close(true);
  });
  lifetime.listen(window, "resize", () => close(true));
  return {
    close,
    plugin(state: EditorSession) {
      return $prose(
        () =>
          new Plugin({
            props: {
              decorations(editorState) {
                if (!active(state) || !state.ready || !state.view?.editable || state.view.composing) return null;
                const range = slashQuery(editorState.selection);
                if (!range || (dismissed?.state === state && dismissed.from === range.from)) return null;
                return DecorationSet.create(editorState.doc, [
                  Decoration.inline(range.from, range.to, { class: "folio-slash-query" }),
                ]);
              },
            },
          }),
      );
    },
    insert(name: string, state: EditorSession | null) {
      const item = commands.find((item) => item.title === name);
      if (!item || (item.kind === "image" && !upload_fn) || !isReadySession(state) || !state.view.editable)
        return false;
      perform(item, state, { from: state.view.state.selection.from, to: state.view.state.selection.to });
      return true;
    },
    update(state: EditorSession, view: EditorView) {
      if (!active(state) || !isReadySession(state) || !view.editable || view.composing || !view.state.selection.empty) {
        close();
        return;
      }
      const range = slashQuery(view.state.selection);
      if (!range) {
        close();
        return;
      }
      const { from, text } = range;
      if (dismissed?.state === state && dismissed.from === from) return;
      const query = text.slice(1).toLowerCase().replace(/\s+/g, "");
      heading.textContent = query ? "Filtered results" : "Basic blocks";
      const matches = commands.flatMap((item, index) => {
        if (item.kind === "image" && !upload_fn) return [];
        const title = item.title.toLowerCase().replace(/\s+/g, "");
        const heading = title.replace("heading", "h");
        return title.includes(query) || heading.includes(query) ? [index] : [];
      });
      if (owner !== state || queryRange?.from !== from) {
        placement = null;
        menu.style.removeProperty("max-height");
      }
      owner = state;
      queryRange = { from, to: view.state.selection.from };
      visible = matches;
      empty.hidden = matches.length > 0;
      if (!matches.length) view.dom.removeAttribute("aria-activedescendant");
      const next = `${from}:${query}`;
      if (signature !== next) {
        signature = next;
        buttons.forEach((button, index) => {
          button.hidden = !visible.includes(index);
        });
        selectedIndex = 0;
      }
      menu.hidden = false;
      view.dom.setAttribute("aria-controls", menu.id);
      select(selectedIndex);
      position();
    },
    props(state: EditorSession) {
      return {
        handleKeyDown(view: EditorView, event: KeyboardEvent) {
          if (menu.hidden || owner !== state || event.isComposing || view.composing) return false;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            select(selectedIndex + 1);
            return true;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            select(selectedIndex - 1);
            return true;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            if (!visible.length) return false;
            event.preventDefault();
            run(selectedIndex);
            return true;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            close(true);
            return true;
          }
          return false;
        },
      };
    },
  };
}
