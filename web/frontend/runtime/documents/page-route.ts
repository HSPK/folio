import { expandedPageUrl, unresolvedPage } from "@folio/model";
import { decodedResource } from "../../api/contracts";
import { api } from "../core/api";
import { loadProjectCatalog } from "../projects/gateway";

/** Resolve fresh bookmarks only after login; the regular resource API enforces note permissions. */
export async function resolvePageRoute(value: string, signal: AbortSignal, loadCatalog = loadProjectCatalog) {
  const url = expandedPageUrl(value);
  if (!unresolvedPage(url)) return url;
  if (url.pathname.startsWith("/n/"))
    await api(`/api/resource?id=${url.pathname.slice(3)}`, { decode: decodedResource, signal });
  else await loadCatalog();
  const resolved = expandedPageUrl(url);
  if (unresolvedPage(resolved)) throw new Error("Link unavailable.");
  return resolved;
}
