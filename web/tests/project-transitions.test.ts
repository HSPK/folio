import test from "node:test";
import assert from "node:assert/strict";
import { createProjectTransitions, type ProjectDestination } from "../frontend/services/project-transitions";
import { createAuthenticationSession } from "../frontend/state/authentication";
import { createProjectService } from "../frontend/services/projects";
import { createProjectModel } from "../frontend/state/projects";

type Ports = Parameters<typeof createProjectTransitions>[0];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(overrides: Partial<Ports> = {}) {
  const authentication = createAuthenticationSession();
  authentication.initialize("users", { username: "alice", id: "alice-id", role: "user", scope: "service" });
  const owner = new AbortController();
  const activated: ProjectDestination[] = [];
  const flow = createProjectTransitions({
    signal: owner.signal,
    scope: () => authentication.scope,
    prepare: async () => true,
    activate: async (target) => {
      activated.push(target);
      return true;
    },
    ...overrides,
  });
  return { authentication, owner, flow, activated };
}

test("the latest project intent cancels an older preparation without allowing its late result to activate", async () => {
  const pending = deferred<boolean>();
  const app = setup({ prepare: (target) => (target.id === "first" ? pending.promise : Promise.resolve(true)) });
  const first = app.flow.request({ id: "first", url: null, mode: "push" });
  const latest = app.flow.request({ id: "latest", url: null, mode: "push" });
  assert.equal(await first, false);
  assert.equal(await latest, true);
  pending.resolve(true);
  await Promise.resolve();
  assert.deepEqual(
    app.activated.map((target) => target.id),
    ["latest"],
  );
});

test("changing credentials cancels project preparation and account-bound activation", async () => {
  const pending = deferred<boolean>();
  const shown = deferred<void>();
  const app = setup({
    prepare: () => {
      shown.resolve();
      return pending.promise;
    },
  });
  const switching = app.flow.request({ id: "private", url: null, mode: "push" });
  await shown.promise;
  app.authentication.beginAuthentication();
  assert.equal(await switching, false);
  pending.resolve(true);
  assert.equal(app.activated.length, 0);
});

test("project routes are copied at intent creation and failed activation errors remain explicit", async () => {
  const pending = deferred<boolean>();
  const app = setup({ prepare: () => pending.promise });
  const url = new URL("https://folio.test/?project=chosen");
  const switching = app.flow.request({ id: "chosen", url, mode: "pop" });
  url.searchParams.set("project", "mutated");
  pending.resolve(true);
  assert.equal(await switching, true);
  assert.equal(app.activated[0].url?.searchParams.get("project"), "chosen");
  const failing = setup({
    activate: async () => {
      throw new Error("History commit was rejected");
    },
  });
  await assert.rejects(failing.flow.request({ id: "chosen", url: null, mode: "push" }), /History commit was rejected/);
});

test("project refreshes coalesce and credential cancellation rejects late responses without projecting them", async () => {
  const app = setup();
  const response = deferred<[]>();
  let reads = 0;
  let accepted = 0;
  const model = createProjectModel();
  model.bindOwner(app.authentication.scope.principal);
  const loader = createProjectService({
    signal: app.owner.signal,
    scope: () => app.authentication.scope,
    read: () => {
      reads++;
      return response.promise;
    },
    model,
    write: async () => {
      throw new Error("No mutation is expected in the refresh fixture.");
    },
    changed: () => {
      accepted++;
    },
  });
  const first = loader.load();
  const second = loader.load();
  const rejected = Promise.all([
    assert.rejects(first, { name: "AbortError" }),
    assert.rejects(second, { name: "AbortError" }),
  ]);
  await Promise.resolve();
  assert.equal(reads, 1);
  app.authentication.beginAuthentication();
  await rejected;
  response.resolve([]);
  await Promise.resolve();
  assert.equal(accepted, 0);
});
