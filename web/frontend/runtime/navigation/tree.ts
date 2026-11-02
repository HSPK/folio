import { projectModel } from "../../state/projects";
import { authenticationSession } from "../../state/authentication";
import { documentSession } from "../../state/document";
import { libraryModel } from "../../state/library";
import { decodedDocument } from "../../api/contracts";
import type { DocumentPayload } from "../../types/domain";
import { datasetValue, requiredClosest, requireValue } from "../../types/elements";
import { errorContext } from "../../types/errors";
import { api } from "../core/api";
import { appState, rootChanged } from "../core/bootstrap";
import { aborted } from "../core/dom";
import { navigateTo } from "../documents/navigation";
import { documentReadUrl, resourceState } from "../documents/resources";
import { listen } from "../lifecycle";

import { publicState } from "../sharing/public";
import { openNewFolder, openNewNote } from "./files";
import { libraryState, renderFiles, updateFileSelection } from "./library";
class TreeState {
  PREFETCH_TTL_MS!: number;
  documentPrefetch!: Map<
    string,
    {
      promise: Promise<DocumentPayload>;
      at: number;
      root: string;
      url: string;
    }
  >;
  treeTypeahead!: {
    text: string;
    at: number;
  };
}
export const treeState = new TreeState();
export function initializeNavigationTree(): void {
  treeState.PREFETCH_TTL_MS = 1500;
  treeState.documentPrefetch = new Map();
  treeState.treeTypeahead = { text: "", at: 0 };
  listen(appState.ui.fileList, "pointerdown", (event) => {
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
  listen(appState.ui.fileList, "click", (event) => {
    if (!(event.target instanceof Element)) return;
    const action = event.target.closest<HTMLButtonElement>("button[data-tree-action]");
    if (action) {
      event.preventDefault();
      event.stopPropagation();
      const directory = datasetValue(requiredClosest(action, "details.directory", HTMLDetailsElement), "path");
      if (action.dataset.treeAction === "note") openNewNote(directory);
      else openNewFolder(directory);
      return;
    }
    const button = event.target.closest<HTMLButtonElement>("button[data-path]");
    if (button) void navigateTo(button.dataset.resourceId ?? datasetValue(button, "path"));
  });
  listen(
    appState.ui.fileList,
    "toggle",
    (event) => {
      if (!(event.target instanceof Element)) return;
      const details = event.target;
      if (!(details instanceof HTMLDetailsElement) || !details.classList.contains("directory")) return;
      const summary = details.querySelector<HTMLElement>(":scope > summary");
      if (!details.open && libraryState.treeTabStop !== summary && details.contains(libraryState.treeTabStop))
        setTreeTabStop(summary);
      if (appState.ui.filter.value.trim()) return;
      libraryModel.setCollapsed(datasetValue(details, "path"), !details.open);
    },
    true,
  );
  listen(appState.ui.fileList, "focusin", (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.target instanceof HTMLElement && event.target.matches(libraryState.TREE_ITEMS))
      setTreeTabStop(event.target);
  });
  listen(appState.ui.fileList, "keydown", (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    const item = event.target;
    if (!(item instanceof HTMLElement)) return;
    if (!item.matches(libraryState.TREE_ITEMS)) return;
    const navigation = ["ArrowDown", "ArrowUp", "Home", "End", "ArrowRight", "ArrowLeft"].includes(event.key);
    if (!navigation && (event.key.length !== 1 || !event.key.trim())) return;
    const next = navigation ? moveTreeFocus(item, event.key) : typeaheadTreeItem(item, event.key);
    event.preventDefault();
    if (next && next !== item) focusTreeItem(next);
  });
  listen(appState.ui.filter, "keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "Escape" && appState.ui.filter.value) {
      event.preventDefault();
      event.stopPropagation();
      appState.ui.filter.value = "";
      renderFiles();
      updateFileSelection();
      libraryState.selectedFileButton?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "Enter") return;
    if (libraryState.fileFilterFrame !== null) renderFiles();
    const first = appState.ui.fileList.querySelector<HTMLButtonElement>(".file-button");
    if (!first || (event.key === "Enter" && !appState.ui.filter.value.trim())) return;
    event.preventDefault();
    if (event.key === "Enter") first.click();
    else focusTreeItem(first);
  });
}
export function treeItemVisible(item: HTMLElement) {
  const start = item.tagName === "SUMMARY" ? requireValue(item.parentElement).parentElement : item.parentElement;
  return !start?.closest<HTMLDetailsElement>("details:not([open])");
}
export function treeItems() {
  return [...appState.ui.fileList.querySelectorAll<HTMLElement>(libraryState.TREE_ITEMS)].filter(treeItemVisible);
}
export function setTreeTabStop(item: HTMLElement | null): void {
  if (libraryState.treeTabStop === item) return;
  if (libraryState.treeTabStop?.isConnected) {
    libraryState.treeTabStop.tabIndex = -1;
    for (const action of libraryState.treeTabStop.querySelectorAll<HTMLButtonElement>(".directory-actions button"))
      action.tabIndex = -1;
  }
  libraryState.treeTabStop = item ?? null;
  if (!libraryState.treeTabStop) return;
  libraryState.treeTabStop.tabIndex = 0;
  for (const action of libraryState.treeTabStop.querySelectorAll<HTMLButtonElement>(".directory-actions button"))
    action.tabIndex = 0;
}
export function syncTreeTabStop() {
  if (libraryState.selectedFileButton?.isConnected) return setTreeTabStop(libraryState.selectedFileButton);
  if (libraryState.treeTabStop?.isConnected && treeItemVisible(libraryState.treeTabStop)) return;
  setTreeTabStop(appState.ui.fileList.querySelector<HTMLElement>(libraryState.TREE_ITEMS));
}
export function focusTreeItem(item: HTMLElement | null): void {
  if (!item) return;
  setTreeTabStop(item);
  item.focus();
}
export function treeItemLabel(item: HTMLElement) {
  return (item.querySelector<HTMLElement>(".file-name, .directory-label")?.textContent ?? "").toLocaleLowerCase();
}
export function moveTreeFocus(item: HTMLElement, key: string) {
  const items = treeItems();
  const index = items.indexOf(item);
  const directory = item.tagName === "SUMMARY" ? item.closest<HTMLDetailsElement>("details.directory") : null;
  switch (key) {
    case "ArrowDown":
      return items[index + 1];
    case "ArrowUp":
      return items[index - 1];
    case "Home":
      return items[0];
    case "End":
      return items.at(-1);
    case "ArrowRight":
      if (directory && !directory.open) {
        directory.open = true;
        return item;
      }
      return directory && directory.contains(items[index + 1]) ? items[index + 1] : item;
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
export function typeaheadTreeItem(item: HTMLElement, character: string) {
  const now = performance.now();
  treeState.treeTypeahead = {
    text: (now - treeState.treeTypeahead.at < 600 ? treeState.treeTypeahead.text : "") + character.toLocaleLowerCase(),
    at: now,
  };
  const items = treeItems();
  const start = items.indexOf(item);
  const ordered = [
    ...items.slice(start + (treeState.treeTypeahead.text.length === 1 ? 1 : 0)),
    ...items.slice(0, start + 1),
  ];
  return ordered.find((candidate) => treeItemLabel(candidate).startsWith(treeState.treeTypeahead.text)) ?? null;
}
export function prefetchTreeDocument(path: string): void {
  if (appState.connectionState !== "ready" || publicState.publicView || rootChanged() || !appState.currentRoot) return;
  const project = documentSession.current?.project ?? projectModel.active?.id ?? "local";
  const resource = resourceState.resourceLocations.get(resourceState.resourceLocation(project, path));
  if (!resource || resource.kind !== "document" || resource.id === documentSession.current?.id) return;
  if (authenticationSession.mode === "users" && resource.project !== projectModel.active?.id) return;
  const now = performance.now();
  for (const [id, entry] of treeState.documentPrefetch) {
    if (now - entry.at > treeState.PREFETCH_TTL_MS) treeState.documentPrefetch.delete(id);
  }
  if (treeState.documentPrefetch.has(resource.id)) return;
  const url = documentReadUrl(resource.id);
  const promise = api(url, {
    decode: decodedDocument,
  });
  promise.catch(() => {});
  treeState.documentPrefetch.set(resource.id, { promise, at: now, root: appState.currentRoot, url });
}
export async function prefetchedDocument(id: string, signal: AbortSignal) {
  const entry = treeState.documentPrefetch.get(id);
  treeState.documentPrefetch.delete(id);
  if (
    !entry ||
    entry.root !== appState.currentRoot ||
    entry.url !== documentReadUrl(id) ||
    performance.now() - entry.at > treeState.PREFETCH_TTL_MS
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
