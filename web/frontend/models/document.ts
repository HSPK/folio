import { isResourceId } from "./navigation";

export const MAX_MARKDOWN_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();

export interface DocumentPermissions {
  writable: boolean;
  collaborative: boolean;
  owner: boolean;
}

export interface DocumentPayload {
  id: string;
  project?: string;
  path: string;
  content: string;
  html: string | null;
  version: string;
  title?: string | null;
  bom?: boolean;
  warning?: string;
  permissions?: DocumentPermissions;
}

export interface DocumentModel extends DocumentPayload {
  text: string;
  title: string | null;
  format: { bom: boolean; lineEnding: string; mixed: boolean };
}

export interface SaveSnapshot {
  readonly id: string;
  readonly path: string;
  readonly version: string;
  readonly text: string;
  readonly content: string;
}

export type DocumentSessionId = symbol;
export type SessionDocument = Readonly<
  Omit<DocumentModel, "format"> & { root: string | null; format: Readonly<DocumentModel["format"]> }
>;

export interface SaveCheckpoint {
  readonly id: DocumentSessionId;
  readonly root: string | null;
  snapshot: SaveSnapshot;
}

export interface SaveOperation extends SaveCheckpoint {
  readonly completion: Promise<boolean>;
}

export function normalizeEditorText(text: string) {
  return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}

export function createDocumentModel(document: DocumentPayload): DocumentModel {
  const raw = document.bom && !document.content.startsWith("\uFEFF") ? `\uFEFF${document.content}` : document.content;
  const bom = raw.startsWith("\uFEFF");
  const source = bom ? raw.slice(1) : raw;
  const counts = new Map<string, number>();
  let lineEnding: string | null = null;
  for (let index = 0; index < source.length; index += 1) {
    let ending: string;
    if (source[index] === "\r") {
      ending = source[index + 1] === "\n" ? "\r\n" : "\r";
      if (ending === "\r\n") index += 1;
    } else if (source[index] === "\n") ending = "\n";
    else continue;
    lineEnding ??= ending;
    counts.set(ending, (counts.get(ending) ?? 0) + 1);
  }
  for (const [ending, count] of counts) if (count > (counts.get(lineEnding ?? "") ?? 0)) lineEnding = ending;
  return {
    id: document.id,
    project: document.project,
    path: document.path,
    content: raw,
    html: document.html,
    version: document.version,
    title: typeof document.title === "string" ? document.title : null,
    text: normalizeEditorText(source),
    format: { bom, lineEnding: lineEnding ?? "\n", mixed: counts.size > 1 },
  };
}

export function isDirty(document: DocumentModel | null, editorText: string) {
  return Boolean(document && normalizeEditorText(editorText) !== document.text);
}

export function serializeEditorText(document: DocumentModel, editorText: string) {
  const text = normalizeEditorText(editorText);
  if (text === document.text) return document.content;
  const bom = document.format.bom ? "\uFEFF" : "";
  if (!document.format.mixed)
    return bom + (document.format.lineEnding === "\n" ? text : text.replace(/\n/g, document.format.lineEnding));
  let from = 0;
  while (from < document.text.length && from < text.length && document.text[from] === text[from]) from += 1;
  let oldTo = document.text.length;
  let newTo = text.length;
  while (oldTo > from && newTo > from && document.text[oldTo - 1] === text[newTo - 1]) {
    oldTo--;
    newTo--;
  }
  const source = bom ? document.content.slice(1) : document.content;
  let raw = 0;
  let normalized = 0;
  const [rawFrom, rawTo] = [from, oldTo].map((target) => {
    while (normalized < target) {
      raw += source[raw] === "\r" && source[raw + 1] === "\n" ? 2 : 1;
      normalized++;
    }
    return raw;
  });
  const prefix = source.slice(0, rawFrom);
  const suffix = source.slice(rawTo);
  let changed = text.slice(from, newTo).replace(/\n/g, document.format.lineEnding);
  // Keep independent newlines from joining into a CRLF pair across the edited splice.
  if (!changed && prefix.endsWith("\r") && suffix.startsWith("\n")) changed = "\r";
  else if (changed) {
    if (prefix.endsWith("\r") && changed.startsWith("\n")) changed = "\r" + changed;
    if (changed.endsWith("\r") && suffix.startsWith("\n")) changed += "\n";
  }
  return bom + prefix + changed + suffix;
}

export function createSaveSnapshot(document: DocumentModel, editorText: string): SaveSnapshot {
  return Object.freeze({
    id: document.id,
    path: document.path,
    version: document.version,
    text: normalizeEditorText(editorText),
    content: serializeEditorText(document, editorText),
  });
}

export function reconcileSave(snapshot: SaveSnapshot, response: DocumentPayload, currentEditorText: string) {
  if (!isResourceId(snapshot.id) || response.id !== snapshot.id)
    throw new Error("The service returned a different note after saving.");
  const document = createDocumentModel(response);
  const currentText = normalizeEditorText(currentEditorText);
  const text = currentText === snapshot.text ? document.text : currentText;
  return { document, text, dirty: isDirty(document, text) };
}

export function markdownByteLength(content: string) {
  return encoder.encode(content).byteLength;
}

export function formatByteCount(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}
