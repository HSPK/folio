// Keyboard navigation, a single tab stop, and press-time prefetch for the file tree.
const PREFETCH_TTL_MS = 1500;
const documentPrefetch = new Map();
let treeTypeahead = { text: "", at: 0 };

function treeItemVisible(item) {
  const start = item.matches("summary") ? item.parentElement.parentElement : item.parentElement;
  return !start?.closest("details:not([open])");
}

function treeItems() {
  return [...ui.fileList.querySelectorAll(TREE_ITEMS)].filter(treeItemVisible);
}

function setTreeTabStop(item) {
  if (treeTabStop === item) return;
  if (treeTabStop?.isConnected) {
    treeTabStop.tabIndex = -1;
    for (const action of treeTabStop.querySelectorAll(".directory-actions button")) action.tabIndex = -1;
  }
  treeTabStop = item ?? null;
  if (!treeTabStop) return;
  treeTabStop.tabIndex = 0;
  for (const action of treeTabStop.querySelectorAll(".directory-actions button")) action.tabIndex = 0;
}

function syncTreeTabStop() {
  if (selectedFileButton?.isConnected) return setTreeTabStop(selectedFileButton);
  if (treeTabStop?.isConnected && treeItemVisible(treeTabStop)) return;
  setTreeTabStop(ui.fileList.querySelector(TREE_ITEMS));
}

function focusTreeItem(item) {
  if (!item) return;
  setTreeTabStop(item);
  item.focus();
}

function treeItemLabel(item) {
  return (item.querySelector(".file-name, .directory-label")?.textContent ?? "").toLocaleLowerCase();
}

function moveTreeFocus(item, key) {
  const items = treeItems();
  const index = items.indexOf(item);
  const directory = item.matches("summary") ? item.parentElement : null;
  switch (key) {
    case "ArrowDown": return items[index + 1];
    case "ArrowUp": return items[index - 1];
    case "Home": return items[0];
    case "End": return items.at(-1);
    case "ArrowRight":
      if (directory && !directory.open) { directory.open = true; return item; }
      return directory && directory.contains(items[index + 1]) ? items[index + 1] : item;
    case "ArrowLeft": {
      if (directory?.open) { directory.open = false; return item; }
      const parent = (directory ?? item).parentElement.closest("details.directory");
      return parent?.querySelector(":scope > summary") ?? item;
    }
    default: return null;
  }
}

function typeaheadTreeItem(item, character) {
  const now = performance.now();
  treeTypeahead = { text: (now - treeTypeahead.at < 600 ? treeTypeahead.text : "") + character.toLocaleLowerCase(), at: now };
  const items = treeItems();
  const start = items.indexOf(item);
  const ordered = [...items.slice(start + (treeTypeahead.text.length === 1 ? 1 : 0)), ...items.slice(0, start + 1)];
  return ordered.find((candidate) => treeItemLabel(candidate).startsWith(treeTypeahead.text)) ?? null;
}

function prefetchTreeDocument(path) {
  if (connectionState !== "ready" || publicView || rootChanged() || !currentRoot) return;
  const project = activeDocument?.project ?? activeProject?.id ?? "local";
  const resource = resourceLocations.get(resourceLocation(project, path));
  if (!resource || resource.kind !== "document" || resource.id === activeDocument?.id) return;
  if (authMode === "users" && resource.project !== activeProject?.id) return;
  const now = performance.now();
  for (const [id, entry] of documentPrefetch) {
    if (now - entry.at > PREFETCH_TTL_MS) documentPrefetch.delete(id);
  }
  if (documentPrefetch.has(resource.id)) return;
  const promise = api(`/api/document?id=${encodeURIComponent(resource.id)}`);
  promise.catch(() => {});
  documentPrefetch.set(resource.id, { promise, at: now, root: currentRoot });
}

async function prefetchedDocument(id, signal) {
  const entry = documentPrefetch.get(id);
  documentPrefetch.delete(id);
  if (!entry || entry.root !== currentRoot || performance.now() - entry.at > PREFETCH_TTL_MS) return null;
  if (signal.aborted) throw new DOMException("The note request was canceled.", "AbortError");
  let cancel;
  const canceled = new Promise((_, reject) => {
    cancel = () => reject(new DOMException("The note request was canceled.", "AbortError"));
    signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    return await Promise.race([entry.promise, canceled]);
  } catch (error) {
    if (aborted(error) && signal.aborted) throw error;
    return null;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

ui.fileList.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || event.pointerType === "touch"
      || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  const button = event.target.closest("button[data-path]");
  if (button) prefetchTreeDocument(button.dataset.path);
});
ui.fileList.addEventListener("focusin", (event) => {
  if (event.target.matches(TREE_ITEMS)) setTreeTabStop(event.target);
});
ui.fileList.addEventListener("keydown", (event) => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
  const item = event.target;
  if (!item.matches(TREE_ITEMS)) return;
  const navigation = ["ArrowDown", "ArrowUp", "Home", "End", "ArrowRight", "ArrowLeft"].includes(event.key);
  if (!navigation && (event.key.length !== 1 || !event.key.trim())) return;
  const next = navigation ? moveTreeFocus(item, event.key) : typeaheadTreeItem(item, event.key);
  event.preventDefault();
  if (next && next !== item) focusTreeItem(next);
});
ui.filter.addEventListener("keydown", (event) => {
  if (event.isComposing) return;
  if (event.key === "Escape" && ui.filter.value) {
    event.preventDefault();
    event.stopPropagation();
    ui.filter.value = "";
    renderFiles();
    updateFileSelection();
    selectedFileButton?.scrollIntoView({ block: "nearest" });
    return;
  }
  if (event.key !== "ArrowDown" && event.key !== "Enter") return;
  if (fileFilterFrame !== null) renderFiles();
  const first = ui.fileList.querySelector(".file-button");
  if (!first || event.key === "Enter" && !ui.filter.value.trim()) return;
  event.preventDefault();
  if (event.key === "Enter") first.click();
  else focusTreeItem(first);
});
