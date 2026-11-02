import { abortable } from "../../shared/async";
import type { AccountScope } from "../models/authentication";

export interface ProjectDestination {
  readonly id: string | null;
  readonly url: URL | null;
  readonly mode: "push" | "replace" | "pop";
}

interface ProjectTransitionPorts {
  signal: AbortSignal;
  scope: () => AccountScope;
  prepare: (target: ProjectDestination, signal: AbortSignal) => Promise<boolean>;
  activate: (target: ProjectDestination, signal: AbortSignal) => Promise<boolean>;
}

export function createProjectTransitions(ports: ProjectTransitionPorts) {
  let active: AbortController | null = null;
  return {
    cancel() {
      active?.abort();
      active = null;
    },
    async request(target: ProjectDestination) {
      active?.abort();
      const scope = ports.scope();
      if (ports.signal.aborted || scope.signal.aborted) return false;
      const controller = new AbortController();
      const signal = AbortSignal.any([ports.signal, scope.signal, controller.signal]);
      const intent = { ...target, url: target.url ? new URL(target.url) : null };
      active = controller;
      const current = () => !signal.aborted && active === controller && ports.scope().key === scope.key;
      try {
        if (!(await abortable(ports.prepare(intent, signal), signal)) || !current()) return false;
        const activated = await abortable(ports.activate(intent, signal), signal);
        return current() && activated;
      } catch (cause) {
        if (signal.aborted) return false;
        throw cause;
      } finally {
        controller.abort();
        if (active === controller) active = null;
      }
    },
  };
}
