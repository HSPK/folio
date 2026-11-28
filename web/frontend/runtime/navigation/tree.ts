import { projectModel } from "../../state/projects";
import { authenticationSession } from "../../state/authentication";
import { documentSession } from "../../state/document";
import { libraryModel } from "../../state/library";
import { decodedDocument } from "../../api/contracts";
import type { DocumentPayload } from "../../types/domain";
import { element, datasetValue, requireValue } from "../../types/elements";
import { errorContext } from "../../types/errors";
import { api } from "../core/api";
import { appState, rootChanged } from "../core/bootstrap";
import { aborted } from "../core/dom";
import { navigateTo } from "../documents/navigation";
import { documentReadUrl, resourceState } from "../documents/resources";
import { listen, onApplicationDispose } from "../lifecycle";

import { publicState } from "../sharing/public";
import { openFilePanel } from "./panels";
import { finishTreeRename, openFileContextMenu } from "./files";
import { finishTreeName, openPendingFile } from "./creation";
import { libraryState, renderFiles, updateFileSelection } from "./library";
let PREFETCH_TTL_MS: number;
let documentPrefetch: Map<
  string,
  {
    promise: Promise<DocumentPayload>;
    at: number;
    root: string;
    url: string;
    scope: symbol;
    selection: symbol;
    controller: AbortController;
  }
>;
let treeTypeahead: {
  text: string;
  at: number;
};

export function initializeNavigationTree(): void {
  PREFETCH_TTL_MS = 1500;
  documentPrefetch = new Map();
  treeTypeahead = { text: "", at: 0 };
  let hoverTimer: number | undefined;
  const cancelHover = () => window.clearTimeout(hoverTimer);
  onApplicationDispose(cancelHover);
  listen(element("file-list"), "pointerover", (event) => {
    if (event.pointerType !== "mouse" || event.buttons || !(event.target instanceof Element)) return;
    const row = event.target.closest<HTMLButtonElement>("button[data-path]");
    if (row && event.relatedTarget instanceof Node && row.contains(event.relatedTarget)) return;
    cancelHover();
    if (!row || (navigator as Navigator & { connection?: { saveData: boolean } }).connection?.saveData) return;
    hoverTimer = window.setTimeout(() => {
      if (row.isConnected && row.matches(":hover")) prefetchTreeDocument(datasetValue(row, "path"));
    }, 90);
  });
  listen(element("file-list"), "pointerleave", cancelHover);
  listen(element("file-list"), "pointerdown", (event) => {
    cancelHover();
    if (!(event.target instanceof Element)) return;
    if (event.target.closest<HTMLElement>(".directory-actions")) {
      event.stopPropagation();
      return;
    }
    if (
      event.button !== 0 ||
      event.pointerType === "touch" ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const button = event.target.closest<HTMLButtonElement>("button[data-path]");
    if (button) prefetchTreeDocument(datasetValue(button, "path"));
  });
  listen(element("file-list"), "click", (event) => {
    if (!(event.target instanceof Element)) return;
    const panel = event.target.closest<HTMLElement>("[data-panel-path]");
    if (panel?.dataset.panelPath) {
      void openFilePanel(panel.dataset.panelPath);
      return;
    }
    const action = event.target.closest<HTMLButtonElement>("button[data-add-parent]");
    if (action) {
      event.preventDefault();
      event.stopPropagation();
      openFileContextMenu(event, action.dataset.addParent ?? "", "directory", action);
      return;
    }
    const button = event.target.closest<HTMLButtonElement>("button[data-path]");
    const pending = event.target.closest<HTMLButtonElement>("button[data-local-open]");
    if (pending) {
      void openPendingFile(datasetValue(pending, "localOpen"));
      return;
    }
    if (button) void navigateTo(button.dataset.resourceId ?? datasetValue(button, "path"));
  });
  listen(
    element("file-list"),
    "toggle",
    (event) => {
      if (!(event.target instanceof Element)) return;
      const details = event.target;
      if (!(details instanceof HTMLDetailsElement) || !details.classList.contains("directory")) return;
      const summary = details.querySelector<HTMLElement>(":scope > summary");
      if (!details.open && libraryState.treeTabStop !== summary && details.contains(libraryState.treeTabStop))
        setTreeTabStop(summary);
      if (element("file-filter").value.trim()) return;
      libraryModel.setCollapsed(datasetValue(details, "path"), !details.open);
    },
    true,
  );
  listen(element("file-list"), "focusin", (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.target instanceof HTMLElement && event.target.matches(libraryState.TREE_ITEMS))
      setTreeTabStop(event.target);
  });
  listen(element("file-list"), "keydown", (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    const item = event.target;
    const rename = item.closest(".tree-inline-rename")?.querySelector<HTMLInputElement>("[data-rename-path]");
    if (rename && ["Enter", "Escape"].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      finishTreeRename(rename, true, event.key === "Escape");
      return;
    }
    if (item instanceof HTMLInputElement && item.dataset.namingKey && ["Enter", "Escape"].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      void finishTreeName(item, true, event.key === "Escape");
      return;
    }
    if (!(item instanceof HTMLElement)) return;
    if (!item.matches(libraryState.TREE_ITEMS)) return;
    const navigation = ["ArrowDown", "ArrowUp", "Home", "End", "ArrowRight", "ArrowLeft"].includes(event.key);
    if (!navigation && (event.key.length !== 1 || !event.key.trim())) return;
    const next = navigation ? moveTreeFocus(item, event.key) : typeaheadTreeItem(item, event.key);
    event.preventDefault();
    if (next && next !== item) focusTreeItem(next);
  });
  listen(element("file-list"), "focusout", (event) => {
    const input = event.target;
    const group = input instanceof Element ? input.closest(".tree-inline-rename") : null;
    if (group?.isConnected && !(event.relatedTarget instanceof Node && group.contains(event.relatedTarget))) {
      const name = group.querySelector<HTMLInputElement>("[data-rename-path]");
      if (name) finishTreeRename(name, false);
    }
    if (input instanceof HTMLInputElement && input.dataset.namingKey && input.isConnected)
      void finishTreeName(input, false);
  });
  listen(element("file-filter"), "keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "Escape" && element("file-filter").value) {
      event.preventDefault();
      event.stopPropagation();
      element("file-filter").value = "";
      renderFiles();
      updateFileSelection();
      libraryState.selectedFileButton?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "Enter") return;
    if (libraryState.fileFilterFrame !== null) renderFiles();
    const first = element("file-list").querySelector<HTMLButtonElement>(".file-button");
    if (!first || (event.key === "Enter" && !element("file-filter").value.trim())) return;
    event.preventDefault();
    if (event.key === "Enter") first.click();
    else focusTreeItem(first);
  });
}
export function treeItemVisible(item: HTMLElement) {
  const start = item.tagName === "SUMMARY" ? requireValue(item.parentElement).parentElement : item.parentElement;
  return !start?.closest<HTMLDetailsElement>("details:not([open])");
}
function treeItems() {
  return [...element("file-list").querySelectorAll<HTMLElement>(libraryState.TREE_ITEMS)].filter(treeItemVisible);
}
function setTreeTabStop(item: HTMLElement | null): void {
  if (libraryState.treeTabStop === item) return;
  if (libraryState.treeTabStop?.isConnected) {
    libraryState.treeTabStop.tabIndex = -1;
    const action = treeAddButton(libraryState.treeTabStop);
    if (action) action.tabIndex = -1;
  }
  libraryState.treeTabStop = item ?? null;
  if (!libraryState.treeTabStop) return;
  libraryState.treeTabStop.tabIndex = 0;
  const action = treeAddButton(libraryState.treeTabStop);
  if (action) action.tabIndex = 0;
}
function treeAddButton(item: HTMLElement) {
  return (item.matches(".file-button") ? item.parentElement : item)?.querySelector<HTMLButtonElement>(
    ":scope > .directory-actions button",
  );
}
export function syncTreeTabStop() {
  if (libraryState.selectedFileButton?.isConnected && treeItemVisible(libraryState.selectedFileButton))
    return setTreeTabStop(libraryState.selectedFileButton);
  if (libraryState.treeTabStop?.isConnected && treeItemVisible(libraryState.treeTabStop)) return;
  setTreeTabStop(element("file-list").querySelector<HTMLElement>(libraryState.TREE_ITEMS));
}
function focusTreeItem(item: HTMLElement | null): void {
  if (!item) return;
  setTreeTabStop(item);
  item.focus();
}
function treeItemLabel(item: HTMLElement) {
  return (item.querySelector<HTMLElement>(".file-name, .directory-label")?.textContent ?? "").toLocaleLowerCase();
}
function moveTreeFocus(item: HTMLElement, key: string) {
  const directory = item.tagName === "SUMMARY" ? item.closest<HTMLDetailsElement>("details.directory") : null;
  const row = (li?: Element | null) => {
    const first = li?.firstElementChild;
    const target = first instanceof HTMLDetailsElement ? first.firstElementChild : first;
    return target instanceof HTMLElement ? target : null;
  };
  const last = (li?: Element | null) => {
    let child = row(li);
    while (child?.parentElement instanceof HTMLDetailsElement && child.parentElement.open) {
      const next = row(child.parentElement.querySelector(":scope > ul")?.lastElementChild);
      if (!next) break;
      child = next;
    }
    return child;
  };
  switch (key) {
    case "ArrowDown": {
      const child = directory?.open && row(directory.querySelector(":scope > ul")?.firstElementChild);
      if (child) return child;
      for (let li = item.closest("li"); li; li = li.parentElement?.closest("li") ?? null) {
        const next = row(li.nextElementSibling);
        if (next) return next;
      }
      return null;
    }
    case "ArrowUp": {
      const li = item.closest("li");
      return last(li?.previousElementSibling) ?? row(li?.parentElement?.closest("li"));
    }
    case "Home":
      return row(element("file-list").firstElementChild);
    case "End":
      return last(element("file-list").lastElementChild);
    case "ArrowRight":
      if (directory && !directory.open) {
        directory.open = true;
        return item;
      }
      return row(directory?.querySelector(":scope > ul")?.firstElementChild) ?? item;
    case "ArrowLeft": {
      if (directory?.open) {
        directory.open = false;
        return item;
      }
      const parent = requireValue((directory ?? item).parentElement).closest<HTMLDetailsElement>("details.directory");
      return parent?.querySelector<HTMLElement>(":scope > summary") ?? item;
    }
    default:
      return null;
  }
}
function typeaheadTreeItem(item: HTMLElement, character: string) {
  const now = performance.now();
  treeTypeahead = {
    text: (now - treeTypeahead.at < 600 ? treeTypeahead.text : "") + character.toLocaleLowerCase(),
    at: now,
  };
  const items = treeItems();
  const start = items.indexOf(item);
  const ordered = [...items.slice(start + (treeTypeahead.text.length === 1 ? 1 : 0)), ...items.slice(0, start + 1)];
  return ordered.find((candidate) => treeItemLabel(candidate).startsWith(treeTypeahead.text)) ?? null;
}
export function clearTreePrefetch(): void {
  for (const entry of documentPrefetch.values()) entry.controller.abort();
  documentPrefetch.clear();
}
function prefetchTreeDocument(path: string): void {
  if (appState.connectionState !== "ready" || publicState.publicView || rootChanged() || !appState.currentRoot) return;
  const project = documentSession.current?.project ?? projectModel.active?.id ?? "local";
  const resource = resourceState.resourceLocations.get(resourceState.resourceLocation(project, path));
  if (!resource || resource.kind !== "document" || resource.id === documentSession.current?.id) return;
  if (authenticationSession.mode === "users" && resource.project !== projectModel.active?.id) return;
  const now = performance.now();
  const scope = authenticationSession.scope;
  const selection = projectModel.selection;
  const url = documentReadUrl(resource.id);
  for (const [id, entry] of documentPrefetch) {
    if (
      id !== resource.id ||
      now - entry.at > PREFETCH_TTL_MS ||
      entry.scope !== scope.key ||
      entry.selection !== selection ||
      entry.url !== url
    ) {
      entry.controller.abort();
      documentPrefetch.delete(id);
    }
  }
  if (documentPrefetch.has(resource.id)) return;
  const controller = new AbortController();
  const promise = api(url, {
    decode: decodedDocument,
    signal: AbortSignal.any([scope.signal, controller.signal]),
  });
  promise.catch(() => {});
  documentPrefetch.set(resource.id, {
    promise,
    at: now,
    root: appState.currentRoot,
    url,
    scope: scope.key,
    selection,
    controller,
  });
}
export async function prefetchedDocument(id: string, signal: AbortSignal) {
  const entry = documentPrefetch.get(id);
  documentPrefetch.delete(id);
  if (
    !entry ||
    entry.scope !== authenticationSession.scope.key ||
    entry.selection !== projectModel.selection ||
    entry.root !== appState.currentRoot ||
    entry.url !== documentReadUrl(id) ||
    performance.now() - entry.at > PREFETCH_TTL_MS
  )
    return null;
  if (signal.aborted) throw new DOMException("The note request was canceled.", "AbortError");
  let cancel!: () => void;
  const canceled = new Promise<never>((_, reject) => {
    cancel = () => reject(new DOMException("The note request was canceled.", "AbortError"));
    signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    return await Promise.race([entry.promise, canceled]);
  } catch (errorCause) {
    const error = errorContext(errorCause);
    if (aborted(error) && signal.aborted) throw error;
    return null;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
