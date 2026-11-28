import type { ChangedRange, TextSelectionRange } from "./types/editor.ts";

/** A pending paste owns only its original range. Never expand it over newly typed text. */
export function mapImageRange(
  range: TextSelectionRange,
  changes: readonly ChangedRange[],
  afterInsertion = false,
): TextSelectionRange | null {
  const { from, to } = range;
  let start = from;
  let end = to;
  for (const { fromA, toA, fromB, toB } of changes) {
    const delta = toB - fromB - (toA - fromA);
    if (fromA < to && toA > from) return null;
    if (toA < from || (toA === from && (from < to || fromA < toA || afterInsertion))) start += delta;
    if (toA < to || (toA === to && (fromA < toA || (from === to && afterInsertion)))) end += delta;
  }
  return { from: start, to: end };
}

export interface ImageBookmark {
  cancel(): void;
  canCancel(undo: boolean): boolean;
  insert(urls: string[]): boolean;
  beforeRemote(changes: ChangedRange[], next: string): void;
}
