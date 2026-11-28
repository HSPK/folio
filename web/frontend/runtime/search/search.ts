import { loadProjectCatalog as loadProjects } from "../projects/gateway";
import { projectModel } from "../../state/projects";
import { authenticationSession } from "../../state/authentication";
import { documentSession } from "../../state/document";
import { decodedSearch } from "../../api/contracts";
import { createIcon, createButton } from "@folio/editor-runtime";
import { searchUi, updateSearchUi } from "../../state/search";
import { shell } from "../../state/shell";
import type { Project, SearchResult } from "../../types/domain";
import { element, clearTimer } from "../../types/elements";
import { errorContext } from "../../types/errors";
import { closeMenus } from "../accounts/authentication";
import { api } from "../core/api";
import { appState } from "../core/bootstrap";
import { ApiError, aborted, documentNotice, notice } from "../core/dom";
import { showDialog } from "../dialogs/dialogs";
import { navigateTo } from "../documents/navigation";
import { setView } from "../navigation/files";
import { listen, onApplicationDispose } from "../lifecycle";
import { projectDialogState, projectManagerOpen } from "../projects/dialog";
import { switchProject } from "../projects/projects";
let searchDialog: HTMLDialogElement;
let searchTimer: number | null;
let searchController: AbortController | null;
let searchGeneration: number;
let searchTags: string[];
let searchResultKey: string | null;

export function initializeSearchSearch(): void {
  searchDialog = element("search-dialog");
  searchTimer = null;
  searchController = null;
  searchGeneration = 0;
  onApplicationDispose(() => {
    clearTimer(searchTimer);
    searchController?.abort();
    searchGeneration++;
    updateSearchUi({ opened: false, results: [], pending: false });
  });
  searchTags = [];
  updateSearchUi({ results: [] });
  updateSearchUi({ selection: 0 });
  updateSearchUi({ pending: false });
  searchResultKey = null;
  listen(element("workspace-search-open"), "click", () => void openWorkspaceSearch());
  listen(element("sidebar-search-open"), "click", () => void openWorkspaceSearch());
  listen(element("search-close"), "click", () => searchDialog.close());
  listen(searchDialog, "close", () => {
    clearTimer(searchTimer);
    searchController?.abort();
    searchGeneration += 1;
    updateSearchUi({ opened: false });
  });
  listen(element("search-query"), "input", () => {
    clearTimer(searchTimer);
    searchController?.abort();
    searchGeneration += 1;
    setSearchPending(true);
    element("search-empty").hidden = true;
    notice(element("search-message"), "Searching…");
    searchTimer = window.setTimeout(() => void runWorkspaceSearch(), 200);
  });
  for (const id of ["search-project", "search-field"] as const)
    listen(element(id), "change", () => void runWorkspaceSearch());
  listen(element("search-form"), "submit", (event) => {
    event.preventDefault();
    void openSearchResult(searchUi.selection);
  });
  listen(element("search-query"), "keydown", (event) => {
    const count = searchUi.results.length;
    if (searchUi.pending || !count || !["ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    updateSearchUi({
      selection: (searchUi.selection + (event.key === "ArrowDown" ? 1 : -1) + count) % count,
    });
  });
  listen(document, "keydown", (event) => {
    if (
      (event.ctrlKey || event.metaKey) &&
      !event.shiftKey &&
      event.key.toLowerCase() === "p" &&
      authenticationSession.mode === "users"
    ) {
      event.preventDefault();
      if (projectManagerOpen()) {
        if (projectDialogState.projectView === "browse") element("projects-filter").focus();
        return;
      }
      if (!document.querySelector<HTMLDialogElement>("dialog[open]")) void openWorkspaceSearch();
    }
  });
}
function searchKey() {
  return JSON.stringify([
    element("search-query").value,
    element("search-project").value,
    element("search-field").value,
    searchTags,
  ]);
}
function setSearchPending(value: boolean): void {
  updateSearchUi({ pending: value });
}
export async function openWorkspaceSearch({
  tags = [],
}: {
  tags?: string[];
} = {}): Promise<void> {
  if (authenticationSession.mode === "public") return;
  if (authenticationSession.mode !== "users") {
    documentNotice("Sign in to search", "warning");
    return;
  }
  closeMenus();
  searchTags = [...tags];
  updateSearchUi({ selection: 0 });
  searchResultKey = null;
  renderSearchResults([], new Map());
  element("search-empty").hidden = true;
  element("search-query").value = "";
  element("search-project").replaceChildren(
    new Option("All projects", ""),
    ...projectModel.items.map((project) => new Option(project.name, project.id)),
  );
  element("search-project").value = projectModel.active?.id ?? "";
  element("search-field").value = "all";
  element("search-filters").open = !appState.compactLayout.matches || tags.length > 0;
  renderSearchTags([]);
  showDialog(searchDialog);
  updateSearchUi({ opened: true });
  element("search-query").focus();
  await runWorkspaceSearch(0, true);
}
function renderSearchTags(
  facets: {
    tag: string;
    count: number;
  }[],
): void {
  element("search-tag-filters").hidden = facets.length === 0;
  const project = element("search-project").selectedOptions[0]?.textContent || "All projects";
  element("search-filter-label").textContent =
    `Filters · ${project}${searchTags.length ? ` · ${searchTags.length} tags` : ""}`;
  element("search-selected-tags").replaceChildren(
    ...searchTags.map((tag) => {
      const button = createButton({ label: `Remove tag filter ${tag}`, text: tag });
      button.append(createIcon("x"));
      button.addEventListener("click", () => {
        searchTags = searchTags.filter((value) => value !== tag);
        void runWorkspaceSearch();
      });
      return button;
    }),
  );
  element("search-tags").replaceChildren(
    ...facets.map(({ tag, count }) => {
      const button = createButton({ label: `${tag} · ${count}` });

      const selected = searchTags.some((value) => value.toLowerCase() === tag.toLowerCase());
      button.setAttribute("aria-pressed", String(selected));
      button.addEventListener("click", () => {
        const active = searchTags.some((value) => value.toLowerCase() === tag.toLowerCase());
        searchTags = active
          ? searchTags.filter((value) => value.toLowerCase() !== tag.toLowerCase())
          : [...searchTags, tag];
        void runWorkspaceSearch();
      });
      return button;
    }),
  );
}
function renderSearchResults(results: SearchResult[], labels: Map<string, string>): void {
  updateSearchUi({
    results,
    labels,
    query: element("search-query").value,
    selection: Math.min(searchUi.selection, Math.max(0, results.length - 1)),
  });
  element("search-empty").hidden = results.length > 0;
}
async function runWorkspaceSearch(cursor = 0, refresh = false): Promise<void> {
  clearTimer(searchTimer);
  searchController?.abort();
  if (!searchDialog.open) return;
  const controller = new AbortController();
  searchController = controller;
  const generation = ++searchGeneration;
  const key = searchKey();
  const query = element("search-query").value;
  setSearchPending(true);
  element("search-empty").hidden = true;
  notice(element("search-message"), "Searching…");
  try {
    const result = await api("/api/search", {
      decode: decodedSearch,
      method: "POST",
      signal: controller.signal,
      body: {
        query,
        project: element("search-project").value || null,
        field: element("search-field").value,
        tags: searchTags,
        cursor,
        refresh,
      },
    });
    if (generation !== searchGeneration || !searchDialog.open || key !== searchKey()) return;
    if (!Array.isArray(result.results) || !Array.isArray(result.tags) || !Array.isArray(result.projects)) {
      throw new ApiError("Incomplete search response");
    }
    renderSearchTags(result.tags);
    if (searchResultKey !== key) updateSearchUi({ selection: 0 });
    renderSearchResults(
      result.results,
      new Map(result.projects.map((project: Pick<Project, "id" | "name">) => [project.id, project.name])),
    );
    searchResultKey = key;
    setSearchPending(false);
    const message =
      result.warnings?.join("\n") || (result.indexing ? "Indexing…" : result.truncated ? "Results limited" : "");
    notice(element("search-message"), message, result.warnings?.length ? "warning" : "");
    if (result.indexing) searchTimer = window.setTimeout(() => void runWorkspaceSearch(result.cursor), 350);
  } catch (errorCause) {
    const error = errorContext(errorCause);
    if (!aborted(error) && generation === searchGeneration) notice(element("search-message"), error.message, "error");
  }
}
export async function openSearchResult(index: number): Promise<void> {
  if (searchUi.pending || searchResultKey !== searchKey()) return;
  const result = searchUi.results[index];
  if (!result) return;
  searchDialog.close();
  if (projectModel.active?.id !== result.project) {
    await loadProjects();
    const url = new URL(appState.committedUrl);
    url.searchParams.set("project", result.project);
    url.searchParams.set("document", result.id);
    url.hash = "";
    await switchProject(result.project, { url });
    return;
  }
  if (!(await navigateTo(result.id))) return;
  if (documentSession.current?.version !== result.version) return;
  if (result.matchedField === "metadata" && shell.view === "rich") {
    setView("editor");
    appState.editor.revealSelection(result.offset, result.offset, { focus: true });
    return;
  }
  if (shell.view === "rich") {
    if (element("rich-editor").getAttribute("aria-busy") === "true") appState.pendingHeading = result.offset;
    else appState.inlineEditor.jumpTo(result.offset);
  } else if (shell.view !== "preview") {
    appState.editor.focus();
    appState.editor.setSelectionRange(result.offset, result.offset);
  }
}
