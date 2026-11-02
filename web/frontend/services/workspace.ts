import { abortable } from "../../shared/async";
import type { AccountScope } from "../models/authentication";
import type { WorkspaceAction, WorkspaceSnapshot } from "../models/workspace-lists";
import type { WorkspaceModel } from "../state/workspace";

interface WorkspacePorts {
  signal: AbortSignal;
  scope: () => AccountScope;
  model: WorkspaceModel;
  read: (signal: AbortSignal) => Promise<WorkspaceSnapshot>;
  write: (action: WorkspaceAction, signal: AbortSignal) => Promise<WorkspaceSnapshot>;
  changed: () => void;
}

/** Serialize account-bound intent, not callbacks that consult whichever account is current later. */
export function createWorkspaceService(ports: WorkspacePorts) {
  let reading: { key: symbol; promise: Promise<WorkspaceSnapshot> } | null = null;
  let queueKey: symbol | null = null;
  let queue: Promise<WorkspaceSnapshot> | null = null;

  function syncOwner() {
    if (ports.signal.aborted) return;
    const changed = ports.model.bindOwner(ports.scope().principal);
    if (changed) ports.changed();
  }

  function capture() {
    const scope = ports.scope();
    const signal = AbortSignal.any([ports.signal, scope.signal]);
    signal.throwIfAborted();
    if (!scope.principal) throw new Error("Workspace operations require an authenticated account.");
    syncOwner();
    return { scope, signal };
  }

  function ensureCurrent(binding: ReturnType<typeof capture>) {
    binding.signal.throwIfAborted();
    if (ports.scope().key !== binding.scope.key) throw new DOMException("The account workspace changed.", "AbortError");
  }

  async function perform(binding: ReturnType<typeof capture>, action?: WorkspaceAction) {
    ensureCurrent(binding);
    const ticket = ports.model.beginRequest();
    const snapshot = await abortable(
      action ? ports.write(action, binding.signal) : ports.read(binding.signal),
      binding.signal,
    );
    ensureCurrent(binding);
    if (ports.model.accept(ticket, snapshot)) ports.changed();
    return snapshot;
  }

  return {
    syncOwner,
    async load() {
      const binding = capture();
      if (reading?.key === binding.scope.key) return reading.promise;
      const operation = { key: binding.scope.key, promise: perform(binding) };
      reading = operation;
      try {
        return await operation.promise;
      } finally {
        if (reading === operation) reading = null;
      }
    },
    async change(action: WorkspaceAction) {
      const binding = capture();
      const intent = Object.freeze({ ...action });
      if (queueKey !== binding.scope.key) {
        queueKey = binding.scope.key;
        queue = null;
      }
      const send = () => perform(binding, intent);
      // The caller observes its failure; it must not poison later independent actions.
      const work = queue ? queue.then(send, send) : Promise.resolve().then(send);
      queue = work;
      return work;
    },
  };
}
