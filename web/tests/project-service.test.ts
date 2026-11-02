import test from "node:test";
import assert from "node:assert/strict";
import { createAuthenticationSession } from "../frontend/state/authentication";
import { createProjectModel } from "../frontend/state/projects";
import { createProjectService } from "../frontend/services/projects";
import type { Project, ProjectChange } from "../frontend/models/projects";

type Ports = Parameters<typeof createProjectService>[0];
const first: Project = { id: "first", name: "First", owned: true, shared: "edit", pages: {}, imageDirectory: "images" };
const second: Project = { ...first, id: "second", name: "Second" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, failed) => {
    resolve = done;
    reject = failed;
  });
  return { promise, resolve, reject };
}
function setup(overrides: Partial<Ports> = {}) {
  const owner = new AbortController();
  const authentication = createAuthenticationSession();
  authentication.initialize("users", { username: "alice", id: "alice-id", scope: "service", role: "user" });
  const model = createProjectModel();
  model.bindOwner(authentication.scope.principal);
  model.replace(model.request(), [first, second]);
  model.select("first");
  const sent: ProjectChange[] = [];
  const service = createProjectService({
    signal: owner.signal,
    scope: () => authentication.scope,
    model,
    read: async () => [first, second],
    write: async (change) => {
      sent.push(change);
      return change.action === "share" ? { ...first, ...change } : first;
    },
    changed() {},
    ...overrides,
  });
  return { owner, authentication, model, sent, service };
}

test("a delayed catalog refresh cannot overwrite newer confirmed mutations", async () => {
  const response = deferred<Project[]>();
  const started = deferred<void>();
  const app = setup({
    read: () => {
      started.resolve();
      return response.promise;
    },
  });
  const loading = app.service.load();
  await started.promise;
  await app.service.change({ action: "share", id: "first", imageDirectory: "new/images" });
  response.resolve([first, second]);
  await loading;
  assert.equal(app.model.active?.imageDirectory, "new/images");
  assert.equal(app.model.active?.shared, "edit");
  assert.deepEqual(app.sent[0], { action: "share", id: "first", imageDirectory: "new/images" });
});

test("a mutation remains addressed to its original project even if the active selection changes", async () => {
  const response = deferred<Project>();
  const started = deferred<void>();
  const app = setup({
    write: () => {
      started.resolve();
      return response.promise;
    },
  });
  const saving = app.service.change({ action: "share", id: "first", name: "Saved first" });
  await started.promise;
  app.model.select("second");
  response.resolve({ ...first, name: "Saved first" });
  await saving;
  assert.equal(app.model.active?.id, "second");
  assert.equal(app.model.get("first")?.name, "Saved first");
});

test("an unconfirmed mutation invalidates older readbacks instead of accepting a stale catalog", async () => {
  const response = deferred<Project[]>();
  const started = deferred<void>();
  const app = setup({
    read: () => {
      started.resolve();
      return response.promise;
    },
    write: async () => {
      throw new Error("Unconfirmed project write");
    },
  });
  const reading = app.service.load();
  await started.promise;
  await assert.rejects(app.service.change({ action: "share", id: "first", name: "Pending" }), /Unconfirmed/);
  response.resolve([{ ...first, name: "Stale" }]);
  await reading;
  assert.equal(app.model.active?.name, "First");
});

test("credential changes cancel queued project writes and cannot block the next account", async () => {
  const held = deferred<Project>();
  const sent: ProjectChange[] = [];
  const app = setup({
    write: (change) => {
      sent.push(change);
      return sent.length === 1 ? held.promise : Promise.resolve(second);
    },
  });
  const saving = app.service.change({ action: "share", id: "first", name: "Old account" });
  const queued = app.service.change({ action: "revokePublic", id: "first", document: "old-note" });
  const rejected = Promise.all([
    assert.rejects(saving, { name: "AbortError" }),
    assert.rejects(queued, { name: "AbortError" }),
  ]);
  await Promise.resolve();
  app.authentication.beginAuthentication();
  app.authentication.authenticate({ username: "bob", id: "bob-id", scope: "service", role: "user" });
  app.service.syncOwner();
  await app.service.change({ action: "share", id: "second", name: "Bob" });
  await rejected;
  held.reject(new Error("Late obsolete response"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    sent.map((change) => change.action),
    ["share", "share"],
  );
  assert.equal(app.model.items.length, 1);
});

test("refreshes requested after queued writes wait for them and coalesce the same catalog intent", async () => {
  const held = deferred<Project>();
  let reads = 0;
  const app = setup({
    write: () => held.promise,
    read: async () => {
      reads++;
      return [{ ...first, name: "Saved" }];
    },
  });
  const saving = app.service.change({ action: "share", id: "first", name: "Saved" });
  const one = app.service.load();
  const two = app.service.load();
  assert.equal(reads, 0);
  held.resolve({ ...first, name: "Saved" });
  await Promise.all([saving, one, two]);
  assert.equal(reads, 1);
  assert.equal(app.model.active?.name, "Saved");
});
