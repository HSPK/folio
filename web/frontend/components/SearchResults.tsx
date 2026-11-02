import { readableMarkdown } from "@folio/editor-runtime";
import { createVirtualizer, type VirtualItem } from "@tanstack/solid-virtual";
import { createEffect, createMemo, For, Show, untrack, type JSX } from "solid-js";
import { highlightParts } from "../models/search";
import { openSearchResult } from "../runtime/search/search";
import { searchUi } from "../state/search";
import type { SearchResult } from "../types/domain";

interface ResultRowProps {
  result: SearchResult;
  index: number;
  position?: VirtualItem;
  measure?: (node: HTMLLIElement) => void;
}

/** Render one escaped result and update selection independently of the surrounding dialog. */
function ResultRow(props: ResultRowProps) {
  const parts = createMemo(() =>
    highlightParts(
      props.result.matchedField === "metadata" ? props.result.snippet : readableMarkdown(props.result.snippet),
      searchUi.query,
    ),
  );
  const position = (): JSX.CSSProperties | undefined =>
    props.position
      ? {
          position: "absolute",
          top: "0",
          left: "0",
          width: "100%",
          transform: `translateY(${props.position.start}px)`,
        }
      : undefined;

  return (
    <li
      data-index={props.index}
      aria-posinset={props.index + 1}
      aria-setsize={searchUi.results.length}
      style={position()}
      ref={(node) => props.measure?.(node)}
    >
      <button
        type="button"
        data-index={props.index}
        aria-selected={searchUi.selection === props.index}
        disabled={searchUi.pending}
        onClick={() => void openSearchResult(props.index)}
      >
        <strong>{props.result.title}</strong>
        <small>
          {searchUi.labels.get(props.result.project) ?? props.result.project} / {props.result.path}
        </small>
        <span class="search-snippet">
          <For each={parts()}>{(part) => (part.highlighted ? <mark>{part.text}</mark> : part.text)}</For>
        </span>
        <Show when={props.result.matchedField === "metadata"}>
          <span class="search-match-field">Metadata match</span>
        </Show>
      </button>
    </li>
  );
}

/** Virtualize long result collections while keeping small searches in normal document flow. */
export function SearchResults() {
  let viewport!: HTMLDivElement;
  const virtualized = createMemo(() => searchUi.results.length > 80);
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLLIElement>({
    get count() {
      return searchUi.results.length;
    },
    getScrollElement: () => viewport,
    estimateSize: () => 104,
    overscan: 6,
    get enabled() {
      return virtualized() && searchUi.opened;
    },
    getItemKey: (index) => `${searchUi.results[index].project}:${searchUi.results[index].id}`,
  });

  createEffect(() => {
    const selected = searchUi.selection;
    const opened = searchUi.opened;
    const useVirtualizer = virtualized();
    if (!opened) return;
    untrack(() => {
      if (useVirtualizer) virtualizer.scrollToIndex(selected, { align: "auto" });
      else
        viewport
          .querySelector<HTMLButtonElement>(`button[data-index="${selected}"]`)
          ?.scrollIntoView({ block: "nearest" });
    });
  });

  return (
    <div class="search-results-viewport" ref={viewport}>
      <ul
        id="search-results"
        class="workspace-results"
        aria-label="Search results"
        aria-busy={searchUi.pending}
        data-virtualized={virtualized()}
        style={virtualized() ? { position: "relative", height: `${virtualizer.getTotalSize()}px` } : undefined}
      >
        <Show
          when={virtualized()}
          fallback={
            <For each={searchUi.results}>{(result, index) => <ResultRow result={result} index={index()} />}</For>
          }
        >
          <For each={virtualizer.getVirtualItems()}>
            {(position) => (
              <ResultRow
                result={searchUi.results[position.index]}
                index={position.index}
                position={position}
                measure={(node) => virtualizer.measureElement(node)}
              />
            )}
          </For>
        </Show>
      </ul>
    </div>
  );
}
