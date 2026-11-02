import type { DocumentPayload } from "./document";
import { normalizeNotePath } from "./paths";

const resourceIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const isResourceId = (value: unknown): value is string =>
  typeof value === "string" && resourceIdPattern.test(value);

export function browserDocumentTitle(document: Pick<DocumentPayload, "title" | "path"> | null, modified = false) {
  if (!document) return "Folio";
  const title = document.title?.trim() || normalizeNotePath(document.path).split("/").at(-1);
  return `${title}${modified ? " *" : ""} — Folio`;
}

export function readLaunchUrl(value: string | URL) {
  const url = new URL(value);
  const ordinaryFragments: string[] = [];
  let token: string | null = null;
  for (const part of url.hash.slice(1).split("&")) {
    const match = /^token=([a-f0-9]+)$/i.exec(part);
    if (match) token ??= match[1];
    else ordinaryFragments.push(part);
  }
  if (token !== null) url.hash = ordinaryFragments.join("&");
  return { url, token };
}

export function readNoteRoute(value: string | URL) {
  const url = new URL(value);
  if (url.searchParams.has("file") || url.searchParams.has("path"))
    throw new Error("Path-based document URLs are no longer supported.");
  const id = url.searchParams.get("document");
  if (id !== null && !isResourceId(id)) throw new Error("Use a UUID v7 document URL.");
  return { id, hash: url.hash };
}

export function makeNoteUrl(value: string | URL, id: string | null, hash = "") {
  if (id != null && !isResourceId(id)) throw new Error("A document URL requires a UUID v7.");
  const url = new URL(value);
  url.searchParams.delete("file");
  url.searchParams.delete("path");
  if (id && url.pathname !== "/share") url.searchParams.set("document", id);
  else url.searchParams.delete("document");
  url.hash = hash;
  return url;
}

export type RequestTicket = symbol;

export class RequestGate {
  #ticket: RequestTicket | null = null;
  next() {
    return (this.#ticket = Symbol("folio-request"));
  }
  isCurrent(ticket: RequestTicket) {
    return ticket === this.#ticket;
  }
  invalidate() {
    this.#ticket = null;
  }
}
