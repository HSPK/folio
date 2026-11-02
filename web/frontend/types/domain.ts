import type { createInlineEditor, createSharedText, createSourceEditor } from "@folio/editor-runtime";
import type { createSaveSnapshot, DocumentSessionId } from "@folio/model";
export type { DocumentPayload, DocumentPermissions, FileEntry, FileTree } from "@folio/model";
export type { UserIdentity, WorkspaceLists, WorkspaceNote } from "@folio/model";
export type { DraftKeys, DraftSnapshot, EncryptedDraft, LocalDraft } from "@folio/model";
export type { Project } from "@folio/model";
export type { Appearance, Preferences, SettingsSnapshot, WebPreferences } from "@folio/model";
import type { LocalDraft } from "@folio/model";
export type { DocumentSessionId, SaveCheckpoint, SaveOperation, SessionDocument as DocumentModel } from "@folio/model";
export type { DocumentLoad } from "../state/document";
import type { SaveCheckpoint } from "@folio/model";

export type SourceEditor = Omit<ReturnType<typeof createSourceEditor>, "value"> & { value: string };
export type InlineEditor = ReturnType<typeof createInlineEditor>;
export type SharedText = ReturnType<typeof createSharedText>;
export type RelativeSelection = ReturnType<SharedText["relative"]>;
export type SaveSnapshot = ReturnType<typeof createSaveSnapshot>;
export type RouteMode = "push" | "replace" | "pop";
export type ResourceKind = "document" | "directory" | "asset";
export type NoticeKind = "" | "error" | "warning" | "success";
export type ConfirmationChoice = boolean | "discard";
export type Action = Record<string, unknown>;

export interface ResourceEntry {
  id: string;
  kind: ResourceKind;
  path: string;
  project: string;
}

export interface Heading {
  id: string;
  text: string;
  level: number;
  from: number;
}

export interface Selection {
  from: number;
  to: number;
}

export interface ViewPosition extends Selection {
  document: DocumentSessionId;
  focus: boolean;
}

export interface Collaborator {
  id: string;
  name: string;
  color?: number;
  cursor?: NonNullable<RelativeSelection> & { mode?: string };
}

export interface Collaboration {
  id: DocumentSessionId;
  resource: string;
  path: string;
  room: string | null;
  closed: boolean;
  connecting: boolean;
  connected: boolean;
  applying: boolean;
  composing: boolean;
  users: Collaborator[];
  me: Collaborator | null;
  socket: WebSocket | null;
  retry: number | null;
  sequence: number;
  pending: Map<number, number[]>;
  localUpdates: Map<number, Uint8Array>;
  localSequence: number;
  localModified: boolean;
  queue: { data: ArrayBuffer | string; snapshot: boolean }[];
  processing: boolean;
  selection: RelativeSelection;
  recoveryRecord: LocalDraft | null;
  cursorSignature: string | null;
  initialized: boolean;
  saving: boolean;
  failed: boolean;
  shared: SharedText;
  writable?: boolean;
  unmerged?: string | null;
  saveCompletion?: Promise<boolean> | null;
  resolveSave?: ((value: boolean) => void) | null;
  saveAgain?: boolean;
  saveTimer?: number | null;
  finishSave_fn?: ((saved: boolean) => void) | null;
}

export interface Participation {
  id: DocumentSessionId;
  resource: string;
  path: string;
  participant: string | null;
  ready: boolean;
  preparing: boolean;
  composing: boolean;
  timer: number | null;
  controller: AbortController | null;
  polling: boolean;
  recoveryRecord: LocalDraft | null;
  resumeSnapshot: SaveCheckpoint | null;
}

export interface AccountsListing {
  users: { username: string; role: string }[];
  invitations: { id: string; usedBy?: string; expired: boolean; expiresAt: number }[];
}

export interface HistoryRevision {
  id: number;
  version: string;
  created: number;
  actor?: string;
  kind: string;
  size: number;
}

export interface TrashEntry {
  id: number;
  path: string;
  deleted: string | number;
  size: number;
}

export interface PublicLink {
  project: string;
  projectName: string;
  path: string;
  document: string;
  token: string;
  access: string;
  passwordRequired?: boolean;
  expiresAt?: number | null;
}

export interface Backlink {
  id: string;
  path: string;
  title?: string;
}

export interface HistoryView {
  id: string;
  path: string;
  project: string;
  document: DocumentSessionId;
  selected: { content: string; revision: HistoryRevision } | null;
  version?: string;
  current?: string;
}

export interface Command {
  name: string;
  key?: string;
  action: () => void;
  enabled?: () => boolean;
}

export interface SearchResult {
  id: string;
  project: string;
  path: string;
  title: string;
  snippet: string;
  matchedField?: string;
  offset: number;
  version: string;
}

export interface ImageOperation {
  id: DocumentSessionId;
  resource: string;
  path: string;
  project?: string;
  revision?: number;
}
