import { abortable } from "../../shared/async";
import type { AccountScope } from "../models/authentication";
import type { Project } from "../models/projects";
import type { Preferences } from "../types/domain";

export interface SettingsSaveIntent {
  readonly preferences: Preferences;
  readonly project: { readonly id: string; readonly imageDirectory: string } | null;
}

interface SettingsSavePorts {
  signal: AbortSignal;
  scope: () => AccountScope;
  project: (id: string) => Project | null;
  updateProject: (id: string, imageDirectory: string) => Promise<Project>;
  writePreferences: (preferences: Preferences, signal: AbortSignal) => Promise<Preferences>;
}

export class SettingsSaveError extends Error {
  constructor(
    cause: unknown,
    public readonly projectSaved: boolean,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "SettingsSaveError";
  }
}

export function createSettingsSaver(ports: SettingsSavePorts) {
  let queueKey: symbol | null = null;
  let queue = Promise.resolve();
  return {
    async save(value: SettingsSaveIntent) {
      const scope = ports.scope();
      const signal = AbortSignal.any([ports.signal, scope.signal]);
      signal.throwIfAborted();
      const intent = {
        preferences: {
          appearance: { ...value.preferences.appearance },
          web: { ...value.preferences.web, hiddenPatterns: [...value.preferences.web.hiddenPatterns] },
        },
        project: value.project ? Object.freeze({ ...value.project }) : null,
      };
      if (queueKey !== scope.key) {
        queueKey = scope.key;
        queue = Promise.resolve();
      }
      const current = () => {
        signal.throwIfAborted();
        if (ports.scope().key !== scope.key) throw new DOMException("The settings account changed.", "AbortError");
      };
      const commit = async () => {
        let projectSaved = false;
        try {
          current();
          if (intent.project) {
            const project = ports.project(intent.project.id);
            if (!project) throw new Error("The project is no longer accessible. Reopen Settings before saving.");
            if (project.imageDirectory !== intent.project.imageDirectory)
              await abortable(ports.updateProject(project.id, intent.project.imageDirectory), signal);
            current();
            projectSaved = true;
          }
          const preferences = await abortable(ports.writePreferences(intent.preferences, signal), signal);
          current();
          return { preferences, projectSaved };
        } catch (cause) {
          if (signal.aborted || ports.scope().key !== scope.key)
            throw new DOMException("The settings save was canceled.", "AbortError");
          throw new SettingsSaveError(cause, projectSaved);
        }
      };
      const work = queue.then(commit);
      queue = work.then(
        () => undefined,
        () => undefined,
      );
      return work;
    },
  };
}
