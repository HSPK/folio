import test from "node:test";
import assert from "node:assert/strict";
import { createDocumentTransitions, type LeaveChoice } from "../frontend/services/document-transitions";

type Ports = Parameters<typeof createDocumentTransitions>[0];

function deferred<T>() {
  const callbacks: { resolve?: (value: T) => void } = {};
  const promise = new Promise<T>((resolve) => {
    callbacks.resolve = resolve;
  });
  return {
    promise,
    resolve(value: T) {
      assert.ok(callbacks.resolve);
      callbacks.resolve(value);
    },
  };
}

function setup(
  overrides: Partial<Ports> = {},
  state = {
    id: Symbol("document"),
    revision: 1,
    path: "Note.md",
    dirty: true,
    busy: false,
    pending: false,
    conflict: false,
  },
) {
  const owner = new AbortController();
  const blocked: string[] = [];
  const calls = { saves: 0, prompts: 0, edited: 0, resumed: 0, blocked };
  const flow = createDocumentTransitions({
    signal: owner.signal,
    read: () => ({ ...state }),
    inFlight: () => null,
    save: async () => {
      calls.saves++;
      state.dirty = false;
      return true;
    },
    confirm: async () => {
      calls.prompts++;
      return false;
    },
    cancelAutoSave() {},
    resumeAutoSave: () => {
      calls.resumed++;
    },
    onEditingCancelled: () => {
      calls.edited++;
    },
    onBlocked: (reason) => calls.blocked.push(reason),
    timeoutMs: 15000,
    ...overrides,
  });
  return { state, flow, owner, calls };
}

test("the latest leave intent waits for an existing save without saving twice or reopening an obsolete target", async () => {
  const saving = deferred<boolean>();
  const app = setup({ inFlight: () => saving.promise });
  app.state.busy = app.state.pending = true;
  const first = app.flow.request("open the first target");
  const latest = app.flow.request("open the latest target");
  assert.equal(await first, false);
  app.state.dirty = app.state.busy = app.state.pending = false;
  saving.resolve(true);
  assert.equal(await latest, true);
  assert.equal(app.calls.saves, 0);
  assert.equal(app.calls.prompts, 0);
});

test("editing and owner disposal cancel leave intent immediately without canceling the actual pending save", async () => {
  const saving = deferred<boolean>();
  const app = setup({ inFlight: () => saving.promise });
  const leaving = app.flow.request("open another note");
  app.flow.edited();
  assert.equal(await leaving, false);
  assert.equal(app.calls.edited, 1);
  const retry = app.flow.request("retry navigation");
  app.owner.abort();
  assert.equal(await retry, false);
  assert.equal(await app.flow.request("navigate after disposal"), false);
  saving.resolve(true);
});

test("a superseded project intent cancels only its leave request, not the underlying save", async () => {
  const saving = deferred<boolean>();
  const app = setup({ inFlight: () => saving.promise });
  const intent = new AbortController();
  const leaving = app.flow.request("switch projects", "save", intent.signal);
  intent.abort();
  assert.equal(await leaving, false);
  assert.equal(app.calls.prompts, 0);
  app.state.dirty = false;
  saving.resolve(true);
  assert.equal(await app.flow.request("open the current target"), true);
});

test("save failure requires an explicit retry and only a confirmed saved baseline permits leaving", async () => {
  const state = {
    id: Symbol("document"),
    revision: 1,
    path: "Note.md",
    dirty: true,
    busy: false,
    pending: false,
    conflict: false,
  };
  let saves = 0;
  let prompts = 0;
  const app = setup(
    {
      save: async () => {
        if (++saves === 1) return false;
        state.dirty = false;
        return true;
      },
      confirm: async (request) => {
        prompts++;
        assert.equal(request.policy, "save");
        return true;
      },
    },
    state,
  );
  assert.equal(await app.flow.request("create a note"), true);
  assert.equal(saves, 2);
  assert.equal(prompts, 1);
});

test("discard confirmation cannot authorize a different revision even when the state port returns a live object", async () => {
  const state = {
    id: Symbol("document"),
    revision: 1,
    path: "Note.md",
    dirty: true,
    busy: false,
    pending: false,
    conflict: false,
  };
  const answer = deferred<LeaveChoice>();
  const shown = deferred<void>();
  const app = setup(
    {
      read: () => state,
      confirm: () => {
        shown.resolve(undefined);
        return answer.promise;
      },
    },
    state,
  );
  const leaving = app.flow.request("reload from disk", "discard");
  await shown.promise;
  state.revision++;
  answer.resolve(true);
  assert.equal(await leaving, false);
  assert.deepEqual(app.calls.blocked, ["changed"]);
});

test("a save finishing during confirmation closes the pending prompt without a second user click", async () => {
  const shown = deferred<AbortSignal>();
  const app = setup({
    save: async () => false,
    confirm: (request) =>
      new Promise((resolve) => {
        request.signal.addEventListener("abort", () => resolve(false), { once: true });
        shown.resolve(request.signal);
      }),
  });
  const leaving = app.flow.request("open another note");
  const prompt = await shown.promise;
  app.state.dirty = false;
  app.flow.notifySaved();
  assert.equal(await leaving, true);
  assert.equal(prompt.aborted, true);
});
