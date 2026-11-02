import { abortable } from "../../shared/async";
import type { AccountScope } from "../models/authentication";
import type { DocumentPayload } from "../models/document";
import type { LocalDraft } from "../models/drafts";
import type { DocumentSession } from "../state/document";

export type RecoveryResult = "applied" | "canceled" | "unsaved";

interface RecoveryPorts {
  signal: AbortSignal;
  scope: () => AccountScope;
  session: DocumentSession;
  project: () => string | null;
  shared: () => object | null;
  canWrite: () => boolean;
  confirm: (record: LocalDraft, signal: AbortSignal) => Promise<boolean>;
  read: (id: string, signal: AbortSignal) => Promise<DocumentPayload>;
  applySource: (text: string) => void;
  save: () => Promise<boolean | undefined>;
  persistShared: () => Promise<void>;
  remove: (record: LocalDraft) => Promise<void>;
  cancelAutoSave: () => void;
  resumeAutoSave: () => void;
}

export function createDraftRecovery(ports: RecoveryPorts) {
  let active: { record: LocalDraft; controller: AbortController; promise: Promise<RecoveryResult> } | null = null;

  async function restore(record: LocalDraft, controller: AbortController): Promise<RecoveryResult> {
    const scope = ports.scope();
    const signal = AbortSignal.any([ports.signal, scope.signal, controller.signal]);
    const session = ports.session;
    const checkpoint = { id: session.id, revision: session.revision };
    const shared = ports.shared();
    let staged = false;
    let paused = false;
    const owned = () =>
      !ports.signal.aborted && !scope.signal.aborted && ports.scope().key === scope.key && session.id === checkpoint.id;
    const current = () =>
      owned() &&
      !signal.aborted &&
      (staged || session.revision === checkpoint.revision) &&
      ports.project() === record.project &&
      session.current?.id === record.document;
    const unsubscribe = session.subscribe(() => {
      if (!current()) controller.abort();
    });
    try {
      signal.throwIfAborted();
      if (!current() || !ports.canWrite())
        throw new Error("This recovery copy cannot be applied to the current writable note.");
      if (session.loading || session.saving)
        throw new Error("Wait for the current document operation before applying recovery.");
      ports.cancelAutoSave();
      paused = true;
      if (!(await abortable(ports.confirm(record, signal), signal)) || !current()) return "canceled";
      const baseline = shared ? null : await abortable(ports.read(record.document, signal), signal);
      if (!current() || shared !== ports.shared()) return "canceled";
      if (!ports.canWrite() || session.loading || session.saving)
        throw new Error("The note is no longer ready for recovery. Your recovery copy is kept.");
      if (baseline && !session.rebaseRecovery(checkpoint, baseline)) return "canceled";
      staged = true;
      ports.applySource(record.source);
      const saved = shared
        ? (await abortable(ports.persistShared(), signal), true)
        : await abortable(ports.save(), signal);
      if (!current()) return "canceled";
      if (!saved) return "unsaved";
      await abortable(ports.remove(record), signal);
      return current() ? "applied" : "canceled";
    } catch (cause) {
      if (signal.aborted) return "canceled";
      throw cause;
    } finally {
      unsubscribe();
      if (paused && !staged && owned() && ports.project() === record.project) ports.resumeAutoSave();
    }
  }

  return {
    cancel() {
      active?.controller.abort();
      active = null;
    },
    apply(record: LocalDraft) {
      if (active?.record.key === record.key && active.record.generation === record.generation) return active.promise;
      active?.controller.abort();
      const controller = new AbortController();
      const operation = { record, controller, promise: restore(record, controller) };
      active = operation;
      operation.promise.then(
        () => {
          if (active === operation) active = null;
        },
        () => {
          if (active === operation) active = null;
        },
      );
      return operation.promise;
    },
  };
}
