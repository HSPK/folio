import { createButton } from "@folio/editor-runtime";
import { authenticationSession } from "../../state/authentication";
import { libraryCatalog, libraryModel } from "../../state/library";
import { projectModel } from "../../state/projects";
import { appState } from "../core/bootstrap";
import { readLayoutPreference, storeLayoutPreference } from "../core/layout";
import { listen } from "../lifecycle";
import { element, requiredQuery } from "../../types/elements";

/** Glyphs a reader may give a note or folder; the first restores the default. */
const choices = ["", "star", "book-open", "edit", "code", "image", "link", "list", "table", "users", "lock", "globe"];
let selected: { path: string; kind: "file" | "directory"; scope: symbol; storage: string } | null = null;

/** Entry icons belong to one account's view of one project, like folder states. */
function entryIconsKey() {
  const account = authenticationSession.user?.username ?? "local";
  return `folio.tree.icons.${account}.${projectModel.active?.id ?? appState.currentRoot ?? "default"}`;
}

export function restoreEntryIcons(): void {
  let stored: unknown = null;
  try {
    stored = JSON.parse(readLayoutPreference(entryIconsKey()) ?? "null");
  } catch {
    stored = null;
  }
  const icons = new Map<string, string>();
  if (stored && typeof stored === "object")
    for (const [path, name] of Object.entries(stored))
      if (typeof name === "string" && choices.includes(name)) icons.set(path, name);
  libraryModel.setIcons(icons);
}

function chooseEntryIcon(name: string): void {
  const entry = selected;
  if (!entry || entry.scope !== projectModel.selection || entry.storage !== entryIconsKey()) return;
  const icons = new Map(libraryCatalog.icons);
  if (name) icons.set(entry.path, name);
  else icons.delete(entry.path);
  libraryModel.setIcons(icons);
  storeLayoutPreference(entryIconsKey(), JSON.stringify(Object.fromEntries(icons)));
}

export function relocateEntryIcons(path: string, destination: string, copy = false) {
  const icons = new Map(libraryCatalog.icons);
  let changed = false;
  for (const [source, icon] of libraryCatalog.icons) {
    if (source !== path && (copy || !source.startsWith(`${path}/`))) continue;
    if (!copy) icons.delete(source);
    icons.set(`${destination}${source.slice(path.length)}`, icon);
    changed = true;
  }
  if (!changed) return;
  libraryModel.setIcons(icons);
  storeLayoutPreference(entryIconsKey(), JSON.stringify(Object.fromEntries(icons)));
}

/** Show the icon choices for the entry the context menu was opened on. */
function renderEntryIconChoices(kind: "file" | "directory", path: string): void {
  const current = libraryCatalog.icons.get(path) ?? "";
  element("file-icon-choices").replaceChildren(
    ...choices.map((name) => {
      const button = createButton({
        label: name ? `Icon: ${name}` : "Default icon",
        icon: name || (kind === "file" ? "file" : "folder"),
      });
      button.setAttribute("role", "menuitemradio");
      button.setAttribute("aria-checked", String(name === current));
      button.dataset.entryIcon = name;
      return button;
    }),
  );
}

export function initializeEntryIcons(onChosen: () => void): void {
  const popup = requiredQuery(document, "#entry-icon-popup", HTMLDivElement);
  const close = () => {
    popup.hidePopover();
    selected = null;
  };
  listen(
    element("file-list"),
    "keydown",
    (event) => {
      if (
        event.target instanceof HTMLElement &&
        event.target.matches(".tree-entry-icon") &&
        (event.key === "Enter" || event.key === " ")
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        event.target.click();
      }
    },
    true,
  );
  listen(
    element("file-list"),
    "click",
    (event) => {
      if (!(event.target instanceof Element)) return;
      const icon = event.target.closest<HTMLElement>(".tree-entry-icon");
      const row = icon?.closest<HTMLElement>("[data-entry-path]");
      if (!row?.dataset.entryPath || !icon) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onChosen();
      selected = {
        path: row.dataset.entryPath,
        kind: row.dataset.entryKind === "directory" ? "directory" : "file",
        scope: projectModel.selection,
        storage: entryIconsKey(),
      };
      renderEntryIconChoices(selected.kind, selected.path);
      popup.showPopover();
      const anchor = icon.getBoundingClientRect(),
        bounds = popup.getBoundingClientRect();
      popup.style.left = `${Math.max(8, Math.min(anchor.left, innerWidth - bounds.width - 8))}px`;
      popup.style.top = `${Math.max(8, Math.min(anchor.bottom + 5, innerHeight - bounds.height - 8))}px`;
      popup.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus({ preventScroll: true });
    },
    true,
  );
  listen(popup, "keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
    event.stopPropagation();
  });
  listen(element("file-icon-choices"), "click", (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>("button[data-entry-icon]");
    if (!button) return;
    chooseEntryIcon(button.dataset.entryIcon ?? "");
    close();
  });
}
