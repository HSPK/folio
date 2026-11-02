import test from "node:test";
import assert from "node:assert/strict";
import { createPreferenceDefaults, type Preferences } from "../frontend/models/preferences";
import type { Project } from "../frontend/models/projects";
import { createAuthenticationSession } from "../frontend/state/authentication";
import { createProjectModel } from "../frontend/state/projects";
import { createSettingsSaver, SettingsSaveError } from "../frontend/services/settings-saving";
import { decodedPreferences } from "../frontend/api/preferences";

type Ports = Parameters<typeof createSettingsSaver>[0];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(overrides: Partial<Ports> = {}) {
  const authentication = createAuthenticationSession();
  authentication.initialize("users", { username: "alice", id: "alice-id", scope: "service", role: "user" });
  const owner = new AbortController();
  const model = createProjectModel();
  const project: Project = {
    id: "first",
    name: "First",
    imageDirectory: "images",
    owned: true,
    shared: "edit",
    pages: {},
  };
  model.bindOwner(authentication.scope.principal);
  model.replace(model.request(), [project]);
  model.select(project.id);
  const updates: string[] = [];
  const writes: Preferences[] = [];
  const saver = createSettingsSaver({
    signal: owner.signal,
    scope: () => authentication.scope,
    project: model.get,
    updateProject: async (id, imageDirectory) => {
      updates.push(id);
      return model.commit(model.request(), { ...project, imageDirectory });
    },
    writePreferences: async (value) => {
      writes.push(value);
      return value;
    },
    ...overrides,
  });
  const preferences = {
    appearance: { theme: "system", latinFont: "sans-serif", cjkFont: "sans-serif" },
    web: createPreferenceDefaults(),
  };
  return { authentication, owner, model, updates, writes, saver, preferences };
}

test("partial settings failures preserve the confirmed project patch and retry only the remaining preferences", async () => {
  let attempts = 0;
  const written: Preferences[] = [];
  const app = setup({
    writePreferences: async (value) => {
      written.push(value);
      if (++attempts === 1) throw new Error("Preferences unavailable");
      return value;
    },
  });
  const intent = { preferences: app.preferences, project: { id: "first", imageDirectory: "media/new" } };
  const saving = app.saver.save(intent);
  app.preferences.web.hiddenPatterns.push("newer-unsaved-input");
  await assert.rejects(saving, (error) => error instanceof SettingsSaveError && error.projectSaved);
  assert.deepEqual(written[0].web.hiddenPatterns, []);
  assert.equal(app.model.get("first")?.imageDirectory, "media/new");
  assert.equal(app.model.get("first")?.shared, "edit");
  const result = await app.saver.save(intent);
  assert.equal(app.updates.length, 1);
  assert.deepEqual(result.preferences.web.hiddenPatterns, ["newer-unsaved-input"]);
});

test("failed project patches do not commit preferences or claim partial success", async () => {
  const app = setup({
    updateProject: async () => {
      throw new Error("Project denied");
    },
  });
  await assert.rejects(
    app.saver.save({ preferences: app.preferences, project: { id: "first", imageDirectory: "media/new" } }),
    (error) => error instanceof SettingsSaveError && !error.projectSaved,
  );
  assert.equal(app.writes.length, 0);
});

test("a credential change cancels a settings continuation even when the preference gateway ignores abort", async () => {
  const pending = deferred<Preferences>();
  const started = deferred<void>();
  const app = setup({
    writePreferences: () => {
      started.resolve();
      return pending.promise;
    },
  });
  const saving = app.saver.save({ preferences: app.preferences, project: null });
  const rejected = assert.rejects(saving, { name: "AbortError" });
  await started.promise;
  app.authentication.beginAuthentication();
  await rejected;
  pending.resolve(app.preferences);
  await Promise.resolve();
  assert.equal(app.model.active?.imageDirectory, "images");
});

test("preference decoding is independent of UI initialization and rejects malformed directory values", () => {
  const appearance = { theme: "system", latinFont: "sans-serif", cjkFont: "sans-serif" };
  const preferences = decodedPreferences({ appearance, web: { imageDirectory: "media/legacy" } });
  assert.equal(preferences.web.imageDirectory, "media/legacy");
  assert.equal(typeof preferences.web.autoSaveDelayMs, "number");
  assert.throws(() => decodedPreferences({ appearance, web: { imageDirectory: 42 } }), /imageDirectory/);
});
