const compact = /^[A-Za-z0-9_-]{21}[AQgw]$/;
const eight = /^[A-Za-z0-9_-]{8}$/;
type PageKind = "n" | "p";
const ids = new Map<string, string>();
const codes = new Map<string, string>();
export function rememberPageCode(kind: PageKind, id: string, code: unknown) {
  if (typeof code !== "string" || !eight.test(code)) return;
  ids.set(`${kind}/${code}`, id);
  codes.set(`${kind}/${id}`, code);
}
export function clearPageCodes() {
  ids.clear();
  codes.clear();
}
export const unresolvedPage = (url: URL) => /^\/[np]\/[A-Za-z0-9_-]{8}$/.test(url.pathname);

function shortId(hex: string) {
  if (!/^[a-f0-9]{32}$/i.test(hex)) throw new Error("Invalid link identity.");
  return btoa(String.fromCharCode(...Array.from({ length: 16 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function expandId(id: string) {
  if (!compact.test(id)) throw new Error("Invalid short link.");
  return Array.from(atob(id.replace(/-/g, "+").replace(/_/g, "/") + "=="), (char) =>
    char.charCodeAt(0).toString(16).padStart(2, "0"),
  ).join("");
}

export const isPublicPage = (path: string) => path === "/share" || path.startsWith("/s/");
export const isShareId = (id: string) => eight.test(id) || compact.test(id) || /^[a-f0-9]{64}$/i.test(id);
export const shortShareId = (token: string) =>
  eight.test(token) || compact.test(token) ? token : shortId(token.slice(0, 32));
export const shareIdFromUrl = (url: URL) =>
  url.pathname === "/share"
    ? url.searchParams.get("share")
    : url.pathname.startsWith("/s/")
      ? url.pathname.slice(3)
      : null;

/** Controllers use full resource identities. Only the address bar and copied links use compact paths. */
export function expandedPageUrl(value: string | URL) {
  const url = new URL(value);
  if (unresolvedPage(url)) {
    const id = ids.get(url.pathname.slice(1));
    if (!id) return url;
    url.searchParams.set(url.pathname[1] === "n" ? "document" : "project", id);
    url.pathname = "/";
  } else if (url.pathname.startsWith("/n/") && compact.test(url.pathname.slice(3))) {
    const hex = expandId(url.pathname.slice(3));
    url.searchParams.set(
      "document",
      `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    );
    url.pathname = "/";
  } else if (url.pathname.startsWith("/p/") && (url.pathname === "/p/default" || compact.test(url.pathname.slice(3)))) {
    const id = url.pathname.slice(3);
    url.searchParams.set("project", id === "default" ? id : expandId(id));
    url.pathname = "/";
  }
  return url;
}

export function compactPageUrl(value: string | URL) {
  const url = new URL(value);
  const document = url.searchParams.get("document");
  const project = url.searchParams.get("project");
  if (isPublicPage(url.pathname)) {
    const token = shareIdFromUrl(url);
    if (token && isShareId(token)) {
      url.pathname = `/s/${shortShareId(token)}`;
      url.searchParams.delete("share");
    }
  } else if (url.pathname === "/" || url.pathname === "/index.html") {
    if (document) url.pathname = `/n/${codes.get("n/" + document) ?? shortId(document.replaceAll("-", ""))}`;
    else if (project)
      url.pathname = `/p/${project === "default" ? project : (codes.get("p/" + project) ?? shortId(project))}`;
  } else return url;
  url.searchParams.delete("project");
  url.searchParams.delete("document");
  return url;
}
