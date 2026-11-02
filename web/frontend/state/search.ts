import { batch, createSignal } from "solid-js";
import type { SearchResult } from "../types/domain";

interface SearchUiState {
  results: readonly SearchResult[];
  labels: ReadonlyMap<string, string>;
  query: string;
  selection: number;
  pending: boolean;
  opened: boolean;
}

const [results, setResults] = createSignal<readonly SearchResult[]>([]);
const [labels, setLabels] = createSignal<ReadonlyMap<string, string>>(new Map());
const [query, setQuery] = createSignal("");
const [selection, setSelection] = createSignal(0);
const [pending, setPending] = createSignal(false);
const [opened, setOpened] = createSignal(false);

export const searchUi: SearchUiState = {
  get results() {
    return results();
  },
  get labels() {
    return labels();
  },
  get query() {
    return query();
  },
  get selection() {
    return selection();
  },
  get pending() {
    return pending();
  },
  get opened() {
    return opened();
  },
};

/** Publish immutable search metadata without deeply proxying result collections. */
export function updateSearchUi(patch: Partial<SearchUiState>) {
  batch(() => {
    if (patch.results !== undefined) setResults(patch.results);
    if (patch.labels !== undefined) setLabels(patch.labels);
    if (patch.query !== undefined) setQuery(patch.query);
    if (patch.selection !== undefined) setSelection(patch.selection);
    if (patch.pending !== undefined) setPending(patch.pending);
    if (patch.opened !== undefined) setOpened(patch.opened);
  });
}
