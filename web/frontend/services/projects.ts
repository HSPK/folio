import { abortable } from "../../shared/async";
import type { AccountScope } from "../models/authentication";
import { ownedProjectChange, type Project, type ProjectChange } from "../models/projects";
import type { ProjectModel } from "../state/projects";

interface ProjectPorts {
  signal: AbortSignal;
  scope: () => AccountScope;
  model: ProjectModel;
  read: (signal: AbortSignal) => Promise<Project[]>;
  write: (change: ProjectChange, signal: AbortSignal) => Promise<Project>;
  changed: () => void;
}

export function createProjectService(ports: ProjectPorts) {
  let intent = 0;
  let reading: { scope: symbol; intent: number; promise: Promise<void> } | null = null;
  let queueKey: symbol | null = null;
  let queue = Promise.resolve();
  function syncOwner() {
    if (!ports.signal.aborted && ports.model.bindOwner(ports.scope().principal)) ports.changed();
  }
  function capture() {
    const scope = ports.scope();
    const signal = AbortSignal.any([ports.signal, scope.signal]);
    signal.throwIfAborted();
    if (!scope.principal) throw new Error("Project operations require an authenticated account.");
    syncOwner();
    return { scope, signal };
  }
  function current(binding: ReturnType<typeof capture>) {
    binding.signal.throwIfAborted();
    if (ports.scope().key !== binding.scope.key) throw new DOMException("The project account changed.", "AbortError");
  }
  return {
    syncOwner,
    async load() {
      const binding = capture();
      if (reading?.scope === binding.scope.key && reading.intent === intent) return reading.promise;
      const before = queueKey === binding.scope.key ? queue : Promise.resolve();
      const operation = {
        scope: binding.scope.key,
        intent,
        promise: (async () => {
          await before;
          current(binding);
          const request = ports.model.request();
          const projects = await abortable(ports.read(binding.signal), binding.signal);
          current(binding);
          if (ports.model.replace(request, projects)) ports.changed();
        })(),
      };
      reading = operation;
      try {
        await operation.promise;
      } finally {
        if (reading === operation) reading = null;
      }
    },
    async change(value: ProjectChange) {
      const binding = capture();
      const change = ownedProjectChange(value);
      intent++;
      if (queueKey !== binding.scope.key) {
        queueKey = binding.scope.key;
        queue = Promise.resolve();
      }
      const send = async () => {
        current(binding);
        const request = ports.model.request();
        try {
          const project = await abortable(ports.write(change, binding.signal), binding.signal);
          current(binding);
          if (change.action !== "create" && project.id !== change.id)
            throw new Error("The service changed a different project.");
          const accepted = ports.model.commit(request, project);
          ports.changed();
          return accepted;
        } catch (cause) {
          current(binding);
          ports.model.invalidateReadbacks(request);
          throw cause;
        }
      };
      const work = queue.then(send);
      queue = work.then(
        () => undefined,
        () => undefined,
      );
      return work;
    },
  };
}
