import { wikiSchema } from "./wiki.ts";
import { createIcon } from "./icons.ts";
import type { EditorView } from "@milkdown/prose/view";
import type { EditorSession, ReadyEditorSession, WikiDocument } from "./types/editor.ts";
import { isReadySession } from "./editor-session.ts";
import type { Lifetime } from "../../shared/lifetime.ts";
export function createWikiMenu(
  active: (state: EditorSession) => boolean,
  documents: () => WikiDocument[],
  lifetime: Lifetime,
) {
  const menu = document.createElement("div");
  menu.id = "folio-wiki-menu";
  menu.className = "folio-slash-menu";
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", "Link to a note");
  menu.hidden = true;
  document.body.append(menu);
  lifetime.defer(() => menu.remove());
  let owner: ReadyEditorSession | null = null;
  let options: WikiDocument[] = [];
  let selected = 0;
  let start = 0;
  let signature = "";
  const close = () => {
    menu.hidden = true;
    owner?.view?.dom.removeAttribute("aria-activedescendant");
    owner?.view?.dom.removeAttribute("aria-controls");
    owner = null;
    signature = "";
  };
  lifetime.defer(close);
  const select = (index: number) => {
    if (!options.length) return;
    selected = (index + options.length) % options.length;
    [...menu.children].forEach((button, index) => {
      button.setAttribute("aria-selected", String(index === selected));
      button.toggleAttribute("data-active", index === selected);
    });
    owner?.view?.dom.setAttribute("aria-activedescendant", menu.children[selected].id);
    menu.children[selected].scrollIntoView({ block: "nearest" });
  };
  const insert = (index: number) => {
    const state = owner;
    const option = options[index];
    if (!state || !option || !active(state)) return;
    const end = state.view.state.selection.from;
    const from = start;
    close();
    state.editor.action((ctx) => {
      const node = wikiSchema.type(ctx).create({
        target: `/${option.path}`,
        label: option.title ?? option.name ?? option.path.split("/").slice(-1)[0],
      });
      state.view.dispatch(state.view.state.tr.replaceWith(from, end, node).scrollIntoView());
      state.view.focus();
    });
  };
  lifetime.listen(document, "pointerdown", (event) => {
    if (!menu.hidden && (!(event.target instanceof Node) || !menu.contains(event.target))) close();
  });
  lifetime.listen(window, "resize", close);
  return {
    close,
    update(state: EditorSession, view: EditorView) {
      if (!active(state) || !isReadySession(state) || !view.editable || !view.state.selection.empty) {
        close();
        return;
      }
      const { $from } = view.state.selection;
      if ($from.parent.type.spec.code) {
        close();
        return;
      }
      const text = $from.parent.textBetween(0, $from.parentOffset, "", "\ufffc");
      const query = text.match(/\[\[([^\]\n|]*)$/);
      if (!query) {
        close();
        return;
      }
      const candidates = documents()
        .filter((file) => `${file.path} ${file.title ?? ""}`.toLowerCase().includes(query[1].toLowerCase()))
        .slice(0, 12);
      if (!candidates.length) {
        close();
        return;
      }
      start = view.state.selection.from - query[0].length;
      owner = state;
      options = candidates;
      const next = JSON.stringify([start, query[1], candidates.map((file) => [file.path, file.title])]);
      if (signature !== next) {
        menu.replaceChildren(
          ...candidates.map((file, index) => {
            const button = document.createElement("button");
            button.type = "button";
            button.id = `folio-wiki-option-${index}`;
            button.setAttribute("role", "option");
            const glyph = document.createElement("span");
            glyph.className = "folio-slash-glyph";
            glyph.append(createIcon("link"));
            const copy = document.createElement("span");
            copy.className = "folio-slash-copy";
            const title = document.createElement("strong");
            title.textContent = file.title ?? file.name ?? file.path.split("/").slice(-1)[0];
            const location = document.createElement("small");
            location.textContent = file.path;
            copy.append(title, location);
            button.append(glyph, copy);
            lifetime.listen(button, "mousedown", (event) => event.preventDefault());
            lifetime.listen(button, "click", () => insert(index));
            lifetime.listen(button, "pointermove", () => {
              if (index !== selected) select(index);
            });
            return button;
          }),
        );
        signature = next;
        selected = 0;
      }
      menu.hidden = false;
      view.dom.setAttribute("aria-controls", menu.id);
      const coordinates = view.coordsAtPos(view.state.selection.from);
      const bounds = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(12, Math.min(coordinates.left, innerWidth - bounds.width - 12))}px`;
      menu.style.top = `${coordinates.bottom + bounds.height + 8 > innerHeight ? Math.max(12, coordinates.top - bounds.height - 8) : coordinates.bottom + 8}px`;
      select(selected);
    },
    key(state: EditorSession, event: KeyboardEvent) {
      if (menu.hidden || owner !== state) return false;
      if (["ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        select(selected + (event.key === "ArrowDown" ? 1 : -1));
        return true;
      }
      if (["Enter", "Tab"].includes(event.key)) {
        event.preventDefault();
        insert(selected);
        return true;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return true;
      }
      return false;
    },
  };
}
