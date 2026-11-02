import { abortable } from "../../shared/async";
import {
  MAX_MARKDOWN_BYTES,
  createDocumentModel,
  markdownByteLength,
  type DocumentPayload,
  type SaveCheckpoint,
  type SaveOperation,
  type SaveSnapshot,
} from "../models/document";
import type { DocumentSession, SaveAcceptance } from "../state/document";

export interface SaveProblem {
  readonly kind: "conflict" | "save" | "verification" | "too-large";
  readonly error: Error;
}

interface SavePorts {
  signal: AbortSignal;
  session: DocumentSession;
  text: () => string;
  read: (id: string) => Promise<DocumentPayload>;
  write: (snapshot: SaveSnapshot) => Promise<DocumentPayload>;
  classify: (cause: unknown) => { error: Error; conflict: boolean; uncertain: boolean };
  accepted: (checkpoint: SaveCheckpoint, payload: DocumentPayload, result: SaveAcceptance) => void;
  changed: () => void;
  problem: (problem: SaveProblem) => void;
  settled: (checkpoint: SaveCheckpoint, completed: boolean, requested: boolean) => void;
}

/** Own write acknowledgement and retry policy without owning editor DOM or HTTP. */
export function createDocumentSaver(ports: SavePorts) {
  const session = ports.session;
  let unconfirmed: SaveCheckpoint | null = null;
  let requested = false;
  const current = (operation: SaveCheckpoint) => !ports.signal.aborted && operation.id === session.id;
  ports.signal.addEventListener(
    "abort",
    () => {
      unconfirmed = null;
      requested = false;
    },
    { once: true },
  );

  function accept(checkpoint: SaveCheckpoint, payload: DocumentPayload) {
    const result = session.acceptSaved(checkpoint, payload, ports.text());
    if (!result) return false;
    ports.accepted(checkpoint, payload, result);
    return true;
  }

  async function verify(operation: SaveCheckpoint) {
    const payload = await abortable(ports.read(operation.snapshot.id), ports.signal);
    if (!current(operation)) return null;
    const content = createDocumentModel(payload).content;
    const recorded = [operation, unconfirmed].find(
      (candidate) => candidate?.id === session.id && candidate.snapshot.content === content,
    );
    return { payload, recorded };
  }

  function fits(snapshot: SaveSnapshot) {
    if (markdownByteLength(snapshot.content) <= MAX_MARKDOWN_BYTES) return true;
    ports.problem({ kind: "too-large", error: new Error("The note exceeds the 4 MiB limit and has not been saved.") });
    return false;
  }

  async function perform(operation: SaveOperation) {
    let completed = false;
    let submitted = false;
    try {
      ports.changed();
      if (unconfirmed?.id === session.id) {
        const verified = await verify(operation);
        if (!verified) return false;
        if (verified.recorded) {
          accept(verified.recorded, verified.payload);
          unconfirmed = null;
          if (!session.analyze(ports.text()).changed) {
            completed = true;
            return true;
          }
        } else if (verified.payload.version !== unconfirmed.snapshot.version) {
          session.markConflict();
          ports.problem({
            kind: "conflict",
            error: new Error("The document changed while the previous save was unconfirmed."),
          });
          return false;
        }
        operation.snapshot = session.checkpoint(ports.text()).snapshot;
      }
      if (!fits(operation.snapshot)) return false;
      submitted = true;
      const payload = await abortable(ports.write(operation.snapshot), ports.signal);
      if (!current(operation)) return false;
      completed = accept(operation, payload);
      unconfirmed = null;
    } catch (cause) {
      if (!current(operation)) return false;
      const failure = ports.classify(cause);
      if (failure.conflict) {
        if (unconfirmed?.id === session.id) {
          try {
            const verified = await verify(operation);
            if (!verified) return false;
            if (verified.recorded) {
              completed = accept(verified.recorded, verified.payload);
              unconfirmed = null;
              requested = session.analyze(ports.text()).changed;
              return completed;
            }
          } catch (cause) {
            if (!current(operation)) return false;
            ports.problem({ kind: "verification", error: ports.classify(cause).error });
            return false;
          }
        }
        session.markConflict();
        ports.problem({ kind: "conflict", error: failure.error });
      } else {
        if (submitted && failure.uncertain) unconfirmed = operation;
        ports.problem({ kind: "save", error: failure.error });
      }
    } finally {
      const owned = session.finishSave(operation);
      if (current(operation) && owned) {
        const queued = requested;
        requested = false;
        ports.changed();
        ports.settled(operation, completed, queued);
      }
    }
    return completed && current(operation);
  }

  return {
    rememberUnconfirmed(checkpoint: SaveCheckpoint) {
      if (current(checkpoint) && unconfirmed?.id !== session.id) unconfirmed = checkpoint;
    },
    save({ queue = true } = {}): Promise<boolean> {
      if (ports.signal.aborted || !session.current || session.conflict) return Promise.resolve(false);
      if (session.saving) {
        requested ||= queue;
        return session.saving.completion;
      }
      if (!session.analyze(ports.text()).changed) return Promise.resolve(true);
      if (unconfirmed?.id !== session.id || (unconfirmed && unconfirmed.snapshot.version !== session.current.version))
        unconfirmed = null;
      requested = false;
      let resolve!: (completed: boolean) => void;
      let reject!: (cause: unknown) => void;
      const completion = new Promise<boolean>((done, failed) => {
        resolve = done;
        reject = failed;
      });
      const operation = { ...session.checkpoint(ports.text()), completion };
      session.beginSave(operation);
      void perform(operation).then(resolve, reject);
      return completion;
    },
  };
}
