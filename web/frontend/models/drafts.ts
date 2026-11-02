import { isRecord } from "../../shared/objects";
import { isResourceId } from "./navigation";

export interface DraftIdentity {
  readonly scope: string;
  readonly secret: string;
}

export interface DraftSnapshot {
  readonly project: string | null;
  readonly document: string;
  readonly path: string;
  readonly source: string;
  readonly version: string;
  readonly room: string | null;
  readonly updates: string;
  readonly unmerged: boolean;
  readonly selection: { readonly from: number; readonly to: number } | null;
  readonly tab: string;
  readonly keep: boolean;
}

export interface LocalDraft extends DraftSnapshot {
  readonly key: string;
  readonly generation: string;
  readonly updated: number;
}

export interface EncryptedDraft {
  readonly key: string;
  readonly generation: string;
  readonly document: string;
  readonly owner: string;
  readonly updated: number;
  readonly iv: Uint8Array<ArrayBuffer>;
  readonly compressed: boolean;
  readonly payload: ArrayBuffer | Blob;
}

export interface DraftKeys {
  readonly encryption: CryptoKey;
  readonly owner: string;
  readonly identify: (value: string) => Promise<string>;
}

export interface DraftStore {
  byOwner(owner: string): Promise<EncryptedDraft[]>;
  byDocument(document: string): Promise<EncryptedDraft[]>;
  put(record: EncryptedDraft): Promise<void>;
  remove(key: string, owner: string, generation?: string | null): Promise<void>;
  close(): Promise<void>;
}

const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
const position = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function decodedSelection(value: unknown): DraftSnapshot["selection"] {
  if (value === null) return null;
  if (!isRecord(value) || !position(value.from) || !position(value.to))
    throw new Error("This local recovery selection is invalid.");
  return Object.freeze({ from: value.from, to: value.to });
}

export function decodedDraftIdentity(value: DraftIdentity): DraftIdentity {
  if (!value.scope || !hash(value.secret))
    throw new Error("The private recovery key is unavailable. Reconnect before closing unsaved work.");
  return Object.freeze({ scope: value.scope, secret: value.secret });
}

export function decodedDraft(value: unknown): DraftSnapshot {
  if (
    !isRecord(value) ||
    (value.project !== null && typeof value.project !== "string") ||
    !isResourceId(value.document) ||
    typeof value.path !== "string" ||
    typeof value.source !== "string" ||
    typeof value.version !== "string" ||
    !value.version ||
    (value.room !== null && typeof value.room !== "string") ||
    typeof value.updates !== "string" ||
    value.updates.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value.updates) ||
    typeof value.unmerged !== "boolean" ||
    typeof value.tab !== "string" ||
    !value.tab ||
    typeof value.keep !== "boolean"
  )
    throw new Error("This local recovery record is invalid.");
  return Object.freeze({
    project: value.project,
    document: value.document,
    path: value.path,
    source: value.source,
    version: value.version,
    room: value.room,
    updates: value.updates,
    unmerged: value.unmerged,
    selection: decodedSelection(value.selection),
    tab: value.tab,
    keep: value.keep,
  });
}

export function decodedEncryptedDraft(value: unknown): EncryptedDraft {
  if (
    !isRecord(value) ||
    !hash(value.key) ||
    !hash(value.document) ||
    !hash(value.owner) ||
    typeof value.generation !== "string" ||
    !/^[a-f0-9]{32}$/i.test(value.generation) ||
    typeof value.updated !== "number" ||
    !Number.isFinite(value.updated) ||
    value.updated < 0 ||
    !(value.iv instanceof Uint8Array) ||
    value.iv.byteLength !== 12 ||
    typeof value.compressed !== "boolean" ||
    (!(value.payload instanceof ArrayBuffer) && !(value.payload instanceof Blob))
  )
    throw new Error("This encrypted recovery record is invalid.");
  return {
    key: value.key,
    document: value.document,
    owner: value.owner,
    generation: value.generation,
    updated: value.updated,
    iv: new Uint8Array(value.iv),
    compressed: value.compressed,
    payload: value.payload,
  };
}
