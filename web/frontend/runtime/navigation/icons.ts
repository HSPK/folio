import { createIcon } from "@folio/editor-runtime";
import { authenticationSession } from "../../state/authentication";
import { libraryCatalog, libraryModel } from "../../state/library";
import { projectModel } from "../../state/projects";
import { appState } from "../core/bootstrap";
import { readLayoutPreference, storeLayoutPreference } from "../core/layout";
import { listen } from "../lifecycle";

/** Glyphs a reader may give a note or folder; the first restores the default. */
const choices = ["", "star", "book-open", "edit", "code", "image", "link", "list", "table", "users", "lock", "globe"];

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
  const entry = appState.contextFile;
  if (!entry) return;
  const icons = new Map(libraryCatalog.icons);
  if (name) icons.set(entry.path, name);
  else icons.delete(entry.path);
  libraryModel.setIcons(icons);
  storeLayoutPreference(entryIconsKey(), JSON.stringify(Object.fromEntries(icons)));
}

/** Show the icon choices for the entry the context menu was opened on. */
export function renderEntryIconChoices(kind: "file" | "directory", path: string): void {
  const current = libraryCatalog.icons.get(path) ?? "";
  appState.element("file-icon-choices").replaceChildren(
    ...choices.map((name) => {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "menuitemradio");
      button.setAttribute("aria-checked", String(name === current));
      button.setAttribute("aria-label", name ? `Icon: ${name}` : "Default icon");
      button.dataset.entryIcon = name;
      button.append(createIcon(name || (kind === "file" ? "file" : "folder")));
      return button;
    }),
  );
}

export function initializeEntryIcons(onChosen: () => void): void {
  listen(appState.element("file-icon-choices"), "click", (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>("button[data-entry-icon]");
    if (!button) return;
    chooseEntryIcon(button.dataset.entryIcon ?? "");
    onChosen();
  });
}
