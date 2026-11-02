import test from "node:test";
import assert from "node:assert/strict";
import { decodedWorkspace } from "../frontend/api/contracts";
import { createAuthenticationSession } from "../frontend/state/authentication";
import { createWorkspaceModel } from "../frontend/state/workspace";
import { createWorkspaceService } from "../frontend/services/workspace";
import type { WorkspaceAction, WorkspaceSnapshot } from "../frontend/models/workspace-lists";

const firstId = "01961e0b-9831-7000-8000-000000000001";
const secondId = "01961e0b-9831-7000-8000-000000000002";
const alice = { username: "alice", id: "alice-id", scope: "service", role: "user" } as const;
const bob = { ...alice, username: "bob", id: "bob-id" };
type Ports = Parameters<typeof createWorkspaceService>[0];

function snapshot(revision: number, title = "Current", id = firstId): WorkspaceSnapshot {
  const note = { project: "default", id, path: `${title}.md`, title };
  return { revision, workspace: { favorites: [note], recent: [note] } };
}
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
  authentication.initialize("users", alice);
  const model = createWorkspaceModel();
  const updates: number[] = [];
  const service = createWorkspaceService({
    signal: owner.signal,
    scope: () => authentication.scope,
    model,
    read: async () => snapshot(1),
    write: async () => snapshot(2),
    changed: () => updates.push(model.revision),
    ...overrides,
  });
  return { owner, authentication, model, updates, service };
}

test("concurrent workspace refreshes share transport and old-account responses cannot overwrite a new account", async () => {
  const oldResponse = deferred<WorkspaceSnapshot>();
  let reads = 0;
  const app = setup({
    read: () => (++reads === 1 ? oldResponse.promise : Promise.resolve(snapshot(1, "Bob", secondId))),
  });
  const first = app.service.load();
  const second = app.service.load();
  const rejected = Promise.all([
    assert.rejects(first, { name: "AbortError" }),
    assert.rejects(second, { name: "AbortError" }),
  ]);
  assert.equal(reads, 1);
  app.authentication.beginAuthentication();
  app.authentication.authenticate(bob);
  app.service.syncOwner();
  await app.service.load();
  oldResponse.resolve(snapshot(999, "Alice"));
  await rejected;
  assert.equal(app.model.lists.recent[0].title, "Bob");
  assert.equal(app.model.revision, 1);
});

test("queued writes remain bound to their original credentials and new accounts do not wait for an obsolete transport", async () => {
  const oldResponse = deferred<WorkspaceSnapshot>();
  const writes: WorkspaceAction[] = [];
  const app = setup({
    write: (action) => {
      writes.push(action);
      return writes.length === 1 ? oldResponse.promise : Promise.resolve(snapshot(1, "Bob", secondId));
    },
  });
  const first = app.service.change({ action: "visit", project: "default", id: firstId });
  const queued = app.service.change({ action: "favorite", project: "default", id: firstId, value: true });
  const rejected = Promise.all([
    assert.rejects(first, { name: "AbortError" }),
    assert.rejects(queued, { name: "AbortError" }),
  ]);
  await Promise.resolve();
  assert.equal(writes.length, 1);
  app.authentication.beginAuthentication();
  app.authentication.authenticate(bob);
  app.service.syncOwner();
  await app.service.change({ action: "visit", project: "default", id: secondId });
  await rejected;
  oldResponse.reject(new Error("Late obsolete failure"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    writes.map((action) => action.id),
    [firstId, secondId],
  );
  assert.equal(app.model.lists.recent[0].id, secondId);
});

test("a failed mutation does not poison later intent and queued actions are copied before callers can mutate them", async () => {
  const failure = deferred<WorkspaceSnapshot>();
  const writes: WorkspaceAction[] = [];
  const app = setup({
    write: (action) => {
      writes.push(action);
      return writes.length === 1 ? failure.promise : Promise.resolve(snapshot(2));
    },
  });
  const first = app.service.change({ action: "visit", project: "default", id: firstId });
  const rejected = assert.rejects(first, /First request failed/);
  const action = { action: "favorite" as const, project: "default", id: firstId, value: true };
  const next = app.service.change(action);
  action.id = secondId;
  action.value = false;
  failure.reject(new Error("First request failed"));
  await rejected;
  await next;
  assert.deepEqual(writes[1], { action: "favorite", project: "default", id: firstId, value: true });
  assert.equal(app.model.revision, 2);
});

test("equal-revision refreshes cannot replace later write projections and catalog snapshots own their records", async () => {
  const response = deferred<WorkspaceSnapshot>();
  const updated = snapshot(5, "New title");
  const app = setup({ read: () => response.promise, write: async () => updated });
  const reading = app.service.load();
  await app.service.change({ action: "favorite", project: "default", id: firstId, value: true });
  response.resolve(snapshot(5, "Old title"));
  await reading;
  assert.equal(app.model.lists.favorites[0].title, "New title");
  assert.notEqual(app.model.lists.favorites[0], updated.workspace.favorites[0]);
  assert.equal(Object.isFrozen(app.model.lists.favorites[0]), true);
});

test("workspace decoding rejects path-based identities and invalid revision numbers before state is accepted", () => {
  assert.throws(() => decodedWorkspace({ ...snapshot(1), revision: -1 }), /workspace revision/);
  assert.throws(() => decodedWorkspace({ ...snapshot(1), revision: 1.5 }), /workspace revision/);
  assert.throws(() => decodedWorkspace(snapshot(1, "Invalid", "Note.md")), /workspace response is incomplete/);
});
