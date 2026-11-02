import { isResourceId } from "@folio/model";
import type { SearchResult } from "../types/domain";
import { isRecord } from "../types/guards";

interface HighlightPart {
  text: string;
  highlighted: boolean;
}

/** Validate result identities and source offsets before displaying or navigating them. */
export function prepareSearchResults(values: readonly unknown[]): SearchResult[] {
  return values.map((value) => {
    if (
      !isRecord(value) ||
      !isResourceId(value.id) ||
      typeof value.project !== "string" ||
      typeof value.path !== "string" ||
      typeof value.title !== "string" ||
      typeof value.snippet !== "string" ||
      typeof value.version !== "string" ||
      typeof value.offset !== "number" ||
      !Number.isSafeInteger(value.offset) ||
      value.offset < 0 ||
      (value.matchedField !== undefined && typeof value.matchedField !== "string")
    ) {
      throw new Error("The local service returned an incomplete search result.");
    }
    return {
      id: value.id,
      project: value.project,
      path: value.path,
      title: value.title,
      snippet: value.snippet,
      offset: value.offset,
      version: value.version,
      matchedField: value.matchedField,
    };
  });
}

/** Split highlighted matches into text parts so search content never becomes an HTML sink. */
export function highlightParts(value: string, query: string): HighlightPart[] {
  const terms = [...new Set(query.trim().split(/\s+/).filter(Boolean))];
  if (!terms.length) return [{ text: value, highlighted: false }];
  const pattern = new RegExp(terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "giu");
  const parts: HighlightPart[] = [];
  let from = 0;
  for (const match of value.matchAll(pattern)) {
    if (match.index > from) parts.push({ text: value.slice(from, match.index), highlighted: false });
    parts.push({ text: match[0], highlighted: true });
    from = match.index + match[0].length;
  }
  if (from < value.length) parts.push({ text: value.slice(from), highlighted: false });
  return parts;
}
