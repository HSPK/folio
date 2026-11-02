import {
  createDocumentModel,
  createSaveSnapshot,
  isDirty,
  markdownByteLength,
  reconcileSave,
  serializeEditorText,
  type DocumentPayload,
  type DocumentSessionId,
  type SaveCheckpoint,
  type SaveOperation,
  type SessionDocument,
} from "../models/document";

export interface DocumentLoad {
  readonly id: DocumentSessionId;
  readonly revision: number;
  readonly mode: "push" | "replace" | "pop";
  readonly controller: AbortController;
}

export interface SaveAcceptance {
  readonly document: SessionDocument;
  readonly text: string;
  readonly dirty: boolean;
}

function ownedDocument(document: SessionDocument): SessionDocument {
  return Object.freeze({ ...document, format: Object.freeze({ ...document.format }) });
}

export function createDocumentSession() {
  let id: DocumentSessionId = Symbol("document-session");
  let revision = 0;
  let document: SessionDocument | null = null;
  let conflict = false;
  let loading: DocumentLoad | null = null;
  let saving: SaveOperation | null = null;
  let analysis: { changed: boolean; bytes: number; lines: number } | null = null;
  let analyzedText: string | null = null;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };

  const invalidateAnalysis = () => {
    analysis = null;
    analyzedText = null;
  };
  const cancelLoad = () => {
    const previous = loading;
    loading = null;
    previous?.controller.abort();
    return previous;
  };
  const replace = (next: SessionDocument | null) => {
    cancelLoad();
    id = Symbol("document-session");
    revision++;
    document = next ? ownedDocument(next) : null;
    conflict = false;
    saving = null;
    invalidateAnalysis();
    changed();
  };

  return {
    get id() {
      return id;
    },
    get revision() {
      return revision;
    },
    get current() {
      return document;
    },
    get conflict() {
      return conflict;
    },
    get loading() {
      return loading;
    },
    get saving(): Readonly<SaveOperation> | null {
      return saving;
    },
    open(next: SessionDocument) {
      replace(next);
    },
    close() {
      replace(null);
    },
    edited() {
      revision++;
      invalidateAnalysis();
      changed();
    },
    setTitle(title: string | null) {
      if (!document || document.title === title) return;
      document = ownedDocument({ ...document, title });
    },
    markConflict() {
      conflict = true;
    },
    analyze(text: string) {
      if (analysis && analyzedText === text) return analysis;
      let lines = 1;
      if (document) for (const character of text) if (character === "\n") lines++;
      analysis = {
        changed: isDirty(document, text),
        bytes: document ? markdownByteLength(serializeEditorText(document, text)) : 0,
        lines,
      };
      analyzedText = text;
      return analysis;
    },
    checkpoint(text: string): SaveCheckpoint {
      if (!document) throw new Error("A save checkpoint requires an open document.");
      return { id, root: document.root, snapshot: createSaveSnapshot(document, text) };
    },
    rebaseRecovery(expected: { readonly id: DocumentSessionId; readonly revision: number }, payload: DocumentPayload) {
      if (expected.id !== id || expected.revision !== revision || !document || saving || loading) return false;
      if (
        payload.id !== document.id ||
        (document.project !== undefined && payload.project !== undefined && document.project !== payload.project)
      )
        throw new Error("The service returned a different note while preparing local recovery.");
      document = ownedDocument({ ...createDocumentModel(payload), root: document.root });
      conflict = false;
      invalidateAnalysis();
      return true;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    beginSave(operation: SaveOperation) {
      if (operation.id !== id || !document || saving)
        throw new Error("A save must exclusively own the current document session.");
      saving = operation;
    },
    finishSave(operation: SaveOperation) {
      if (saving !== operation) return false;
      saving = null;
      return true;
    },
    acceptSaved(checkpoint: SaveCheckpoint, payload: DocumentPayload, text: string): SaveAcceptance | null {
      if (checkpoint.id !== id || !document) return null;
      const result = reconcileSave(checkpoint.snapshot, payload, text);
      document = ownedDocument({
        ...result.document,
        root: checkpoint.root,
        title: result.dirty ? document.title : result.document.title,
      });
      const revised = result.text !== text;
      if (revised) revision++;
      invalidateAnalysis();
      if (revised) changed();
      return { ...result, document };
    },
    acceptRemote(payload: DocumentPayload, root: string | null) {
      if (!document || payload.id !== document.id)
        throw new Error("A shared save must acknowledge the current document.");
      document = ownedDocument({ ...createDocumentModel(payload), root });
      invalidateAnalysis();
    },
    beginLoad(mode: DocumentLoad["mode"]) {
      cancelLoad();
      loading = { id, revision, mode, controller: new AbortController() };
      return loading;
    },
    isCurrentLoad(operation: DocumentLoad) {
      return (
        loading === operation &&
        operation.id === id &&
        operation.revision === revision &&
        !operation.controller.signal.aborted
      );
    },
    cancelLoad,
    finishLoad(operation: DocumentLoad) {
      if (loading !== operation) return false;
      loading = null;
      return true;
    },
  };
}

export type DocumentSession = ReturnType<typeof createDocumentSession>;
export const documentSession = createDocumentSession();
