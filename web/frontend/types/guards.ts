import { isResourceId } from "@folio/model";
import type { DocumentPayload, FileEntry, WorkspaceNote } from "./domain";
import { isRecord } from "../../shared/objects";
export { isRecord } from "../../shared/objects";

/** Check document identity and content before accepting an editor baseline. */
export function isDocumentPayload(value: unknown): value is DocumentPayload {
  return (
    isRecord(value) &&
    isResourceId(value.id) &&
    typeof value.path === "string" &&
    typeof value.content === "string" &&
    (value.html === null || typeof value.html === "string") &&
    typeof value.version === "string" &&
    value.version.length > 0 &&
    (value.title === undefined || value.title === null || typeof value.title === "string") &&
    (value.project === undefined || typeof value.project === "string") &&
    (value.bom === undefined || typeof value.bom === "boolean") &&
    (value.warning === undefined || typeof value.warning === "string")
  );
}

/** Check file-list rows before using them in navigation or resource matching. */
export function isFileEntry(value: unknown): value is FileEntry {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    typeof value.name === "string" &&
    (value.id === undefined || isResourceId(value.id)) &&
    (value.title === undefined || value.title === null || typeof value.title === "string")
  );
}

/** Validate saved workspace references without accepting path-based document identities. */
export function isWorkspaceNote(value: unknown): value is WorkspaceNote {
  return (
    isRecord(value) &&
    isResourceId(value.id) &&
    typeof value.project === "string" &&
    typeof value.path === "string" &&
    typeof value.title === "string"
  );
}
