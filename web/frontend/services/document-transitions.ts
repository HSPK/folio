import { abortable } from "../../shared/async";
import type { DocumentSessionId } from "../models/document";

export type LeavePolicy = "save" | "discard";
export type LeaveChoice = boolean | "discard";

export interface TransitionSnapshot {
  readonly id: DocumentSessionId;
  readonly revision: number;
  readonly path: string | null;
  readonly dirty: boolean;
  readonly busy: boolean;
  readonly pending: boolean;
  readonly conflict: boolean;
}

export interface LeaveConfirmation {
  action: string;
  policy: LeavePolicy;
  snapshot: TransitionSnapshot;
  signal: AbortSignal;
}

interface TransitionPorts {
  signal: AbortSignal;
  read: () => TransitionSnapshot;
  save: () => Promise<boolean | undefined>;
  inFlight: () => Promise<boolean> | null;
  confirm: (request: LeaveConfirmation) => Promise<LeaveChoice>;
  cancelAutoSave: () => void;
  resumeAutoSave: () => void;
  onEditingCancelled: () => void;
  onBlocked: (reason: "busy" | "changed") => void;
  timeoutMs: number;
  now?: () => number;
}

interface Transition {
  id: DocumentSessionId;
  controller: AbortController;
  saved?: () => void;
}

/** Coordinate leave intent independently of DOM, transport, or controller initialization order. */
export function createDocumentTransitions(ports: TransitionPorts) {
  let active: Transition | null = null;
  const now = ports.now ?? (() => performance.now());
  const clean = () => {
    const state = ports.read();
    return !state.dirty && !state.busy;
  };
  const current = (transition: Transition) =>
    active === transition &&
    !ports.signal.aborted &&
    !transition.controller.signal.aborted &&
    transition.id === ports.read().id;

  async function ask(
    transition: Transition,
    action: string,
    policy: LeavePolicy,
    snapshot: TransitionSnapshot,
    signal: AbortSignal,
  ) {
    const prompt = new AbortController();
    const promptSignal = AbortSignal.any([signal, prompt.signal]);
    const saved = new Promise<"saved">((resolve) => {
      transition.saved = () => {
        if (current(transition) && clean()) resolve("saved");
      };
    });
    try {
      const question = ports.confirm({ action, policy, snapshot, signal: promptSignal });
      transition.saved?.();
      const choice = await abortable(Promise.race([question, saved]), signal);
      return choice === "saved" ? true : choice;
    } finally {
      transition.saved = undefined;
      prompt.abort();
    }
  }

  async function request(action: string, policy: LeavePolicy = "save", intentSignal?: AbortSignal) {
    if (ports.signal.aborted || intentSignal?.aborted) return false;
    active?.controller.abort();
    const transition: Transition = { id: ports.read().id, controller: new AbortController() };
    const signal = AbortSignal.any([
      ports.signal,
      transition.controller.signal,
      ...(intentSignal ? [intentSignal] : []),
    ]);
    active = transition;
    let deadline = now() + ports.timeoutMs * 2;
    try {
      while (current(transition)) {
        const state = ports.read();
        if (!state.path || (!state.dirty && !state.busy)) return true;
        ports.cancelAutoSave();
        if (policy === "save" || !state.dirty) {
          const saving = ports.inFlight();
          const saved = await abortable(saving ?? ports.save(), signal);
          if (!current(transition)) return false;
          if (clean()) return true;
          if (policy === "save" && (saved || ports.read().pending) && now() < deadline) continue;
        }
        const snapshot = Object.freeze({ ...ports.read() });
        if (policy === "discard" && !snapshot.dirty && snapshot.busy) {
          ports.onBlocked("busy");
          return false;
        }
        const choice = await ask(transition, action, policy, snapshot, signal);
        if (!current(transition)) return false;
        if (clean()) return true;
        if (!choice) {
          if (policy === "discard") ports.resumeAutoSave();
          return false;
        }
        if (policy === "discard" || choice === "discard" || snapshot.conflict) {
          const latest = ports.read();
          if (latest.busy || latest.revision !== snapshot.revision) {
            ports.onBlocked(latest.busy ? "busy" : "changed");
            return false;
          }
          return true;
        }
        deadline = now() + ports.timeoutMs * 2;
      }
      return false;
    } catch (error) {
      if (signal.aborted) return false;
      throw error;
    } finally {
      transition.controller.abort();
      if (active === transition) active = null;
    }
  }

  return {
    request,
    notifySaved() {
      active?.saved?.();
    },
    edited() {
      if (!active || ports.signal.aborted || active.controller.signal.aborted) return;
      active.controller.abort();
      ports.onEditingCancelled();
    },
    cancel() {
      active?.controller.abort();
      active = null;
    },
  };
}
