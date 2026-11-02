import { loadProjectCatalog as loadProjects } from "../projects/gateway";
import { projectModel } from "../../state/projects";
import { authenticationSession } from "../../state/authentication";
import { documentSession } from "../../state/document";
import { decodedSearch } from "../../api/contracts";
import { createIcon } from "@folio/editor-runtime";
import { searchUi, updateSearchUi } from "../../state/search";
import { shell } from "../../state/shell";
import type { Project, SearchResult } from "../../types/domain";
import { clearTimer } from "../../types/elements";
import { errorContext } from "../../types/errors";
import { closeMenus } from "../accounts/authentication";
import { api } from "../core/api";
import { appState } from "../core/bootstrap";
import { ApiError, aborted, documentNotice, notice } from "../core/dom";
import { showDialog } from "../dialogs/dialogs";
import { navigateTo } from "../documents/navigation";
import { listen, onApplicationDispose } from "../lifecycle";
import { projectDialogState, projectManagerOpen } from "../projects/dialog";
import { switchProject } from "../projects/projects";
class SearchState {
  searchDialog!: HTMLDialogElement;
  searchTimer!: number | null;
  searchController!: AbortController | null;
  searchGeneration!: number;
  searchTags!: string[];
  searchResultKey!: string | null;
}
export const searchState = new SearchState();
export function initializeSearchSearch(): void {
  searchState.searchDialog = appState.element("search-dialog");
  searchState.searchTimer = null;
  searchState.searchController = null;
  searchState.searchGeneration = 0;
  onApplicationDispose(() => {
    clearTimer(searchState.searchTimer);
    searchState.searchController?.abort();
    searchState.searchGeneration++;
    updateSearchUi({ opened: false, results: [], pending: false });
  });
  searchState.searchTags = [];
  updateSearchUi({ results: [] });
  updateSearchUi({ selection: 0 });
  updateSearchUi({ pending: false });
  searchState.searchResultKey = null;
  listen(appState.element("workspace-search-open"), "click", () => void openWorkspaceSearch());
  listen(appState.element("sidebar-search-open"), "click", () => void openWorkspaceSearch());
  listen(appState.element("search-close"), "click", () => searchState.searchDialog.close());
  listen(searchState.searchDialog, "close", () => {
    clearTimer(searchState.searchTimer);
    searchState.searchController?.abort();
    searchState.searchGeneration += 1;
    updateSearchUi({ opened: false });
  });
  listen(appState.element("search-query"), "input", () => {
    clearTimer(searchState.searchTimer);
    searchState.searchController?.abort();
    searchState.searchGeneration += 1;
    setSearchPending(true);
    appState.element("search-empty").hidden = true;
    notice(appState.element("search-message"), "Searching notes…");
    searchState.searchTimer = window.setTimeout(() => void runWorkspaceSearch(), 200);
  });
  for (const id of ["search-project", "search-field"] as const)
    listen(appState.element(id), "change", () => void runWorkspaceSearch());
  listen(appState.element("search-form"), "submit", (event) => {
    event.preventDefault();
    void openSearchResult(searchUi.selection);
  });
  listen(appState.element("search-query"), "keydown", (event) => {
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
        if (projectDialogState.projectView === "browse") appState.element("projects-filter").focus();
        return;
      }
      if (!document.querySelector<HTMLDialogElement>("dialog[open]")) void openWorkspaceSearch();
    }
  });
}
export function searchKey() {
  return JSON.stringify([
    appState.element("search-query").value,
    appState.element("search-project").value,
    appState.element("search-field").value,
    searchState.searchTags,
  ]);
}
export function setSearchPending(value: boolean): void {
  updateSearchUi({ pending: value });
}
export async function openWorkspaceSearch({
  tags = [],
}: {
  tags?: string[];
} = {}): Promise<void> {
  if (authenticationSession.mode !== "users") {
    documentNotice("Library search requires a signed-in account.", "warning");
    return;
  }
  closeMenus();
  searchState.searchTags = [...tags];
  updateSearchUi({ selection: 0 });
  searchState.searchResultKey = null;
  renderSearchResults([], new Map());
  appState.element("search-empty").hidden = true;
  appState.element("search-query").value = "";
  appState
    .element("search-project")
    .replaceChildren(
      new Option("All projects", ""),
      ...projectModel.items.map((project) => new Option(project.name, project.id)),
    );
  appState.element("search-project").value = projectModel.active?.id ?? "";
  appState.element("search-field").value = "all";
  appState.element("search-filters").open = !appState.compactLayout.matches || tags.length > 0;
  renderSearchTags([]);
  showDialog(searchState.searchDialog);
  updateSearchUi({ opened: true });
  appState.element("search-query").focus();
  await runWorkspaceSearch(0, true);
}
export function renderSearchTags(
  facets: {
    tag: string;
    count: number;
  }[],
): void {
  appState.element("search-tag-filters").hidden = facets.length === 0;
  const project = appState.element("search-project").selectedOptions[0]?.textContent || "All projects";
  appState.element("search-filter-label").textContent =
    `Filters · ${project}${searchState.searchTags.length ? ` · ${searchState.searchTags.length} tags` : ""}`;
  appState.element("search-selected-tags").replaceChildren(
    ...searchState.searchTags.map((tag) => {
      const button = document.createElement("button");
      button.type = "button";
      button.append(document.createTextNode(tag), createIcon("x"));
      button.setAttribute("aria-label", `Remove tag filter ${tag}`);
      button.addEventListener("click", () => {
        searchState.searchTags = searchState.searchTags.filter((value) => value !== tag);
        void runWorkspaceSearch();
      });
      return button;
    }),
  );
  appState.element("search-tags").replaceChildren(
    ...facets.map(({ tag, count }) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `${tag} · ${count}`;
      const selected = searchState.searchTags.some((value) => value.toLowerCase() === tag.toLowerCase());
      button.setAttribute("aria-pressed", String(selected));
      button.addEventListener("click", () => {
        const active = searchState.searchTags.some((value) => value.toLowerCase() === tag.toLowerCase());
        searchState.searchTags = active
          ? searchState.searchTags.filter((value) => value.toLowerCase() !== tag.toLowerCase())
          : [...searchState.searchTags, tag];
        void runWorkspaceSearch();
      });
      return button;
    }),
  );
}
export function renderSearchResults(results: SearchResult[], labels: Map<string, string>): void {
  updateSearchUi({
    results,
    labels,
    query: appState.element("search-query").value,
    selection: Math.min(searchUi.selection, Math.max(0, results.length - 1)),
  });
  appState.element("search-empty").hidden = results.length > 0;
}
export async function runWorkspaceSearch(cursor = 0, refresh = false): Promise<void> {
  clearTimer(searchState.searchTimer);
  searchState.searchController?.abort();
  if (!searchState.searchDialog.open) return;
  const controller = new AbortController();
  searchState.searchController = controller;
  const generation = ++searchState.searchGeneration;
  const key = searchKey();
  const query = appState.element("search-query").value;
  setSearchPending(true);
  appState.element("search-empty").hidden = true;
  notice(appState.element("search-message"), "Searching notes…");
  try {
    const result = await api("/api/search", {
      decode: decodedSearch,
      method: "POST",
      signal: controller.signal,
      body: {
        query,
        project: appState.element("search-project").value || null,
        field: appState.element("search-field").value,
        tags: searchState.searchTags,
        cursor,
        refresh,
      },
    });
    if (generation !== searchState.searchGeneration || !searchState.searchDialog.open || key !== searchKey()) return;
    if (!Array.isArray(result.results) || !Array.isArray(result.tags) || !Array.isArray(result.projects)) {
      throw new ApiError("The search response is incomplete.");
    }
    renderSearchTags(result.tags);
    if (searchState.searchResultKey !== key) updateSearchUi({ selection: 0 });
    renderSearchResults(
      result.results,
      new Map(result.projects.map((project: Pick<Project, "id" | "name">) => [project.id, project.name])),
    );
    searchState.searchResultKey = key;
    setSearchPending(false);
    const message =
      result.warnings?.join("\n") ||
      (result.indexing
        ? "Indexing notes; results are updating…"
        : result.truncated
          ? "Showing a limited set of results. Narrow the query or tags."
          : "");
    notice(appState.element("search-message"), message, result.warnings?.length ? "warning" : "");
    if (result.indexing) searchState.searchTimer = window.setTimeout(() => void runWorkspaceSearch(result.cursor), 350);
  } catch (errorCause) {
    const error = errorContext(errorCause);
    if (!aborted(error) && generation === searchState.searchGeneration)
      notice(appState.element("search-message"), error.message, "error");
  }
}
export async function openSearchResult(index: number): Promise<void> {
  if (searchUi.pending || searchState.searchResultKey !== searchKey()) return;
  const result = searchUi.results[index];
  if (!result) return;
  searchState.searchDialog.close();
  if (projectModel.active?.id !== result.project) {
    await loadProjects();
    const url = new URL(window.location.href);
    url.searchParams.set("project", result.project);
    url.searchParams.set("document", result.id);
    url.hash = "";
    await switchProject(result.project, { url });
    return;
  }
  if (!(await navigateTo(result.id))) return;
  if (documentSession.current?.version !== result.version) return;
  if (shell.view === "rich") {
    if (appState.element("rich-editor").getAttribute("aria-busy") === "true") appState.pendingHeading = result.offset;
    else appState.inlineEditor.jumpTo(result.offset);
  } else if (shell.view !== "preview") {
    appState.ui.editor.focus();
    appState.ui.editor.setSelectionRange(result.offset, result.offset);
  }
}
