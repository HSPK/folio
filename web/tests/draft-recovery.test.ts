import test from "node:test";
import assert from "node:assert/strict";
import { createDocumentModel, type DocumentPayload, type SaveSnapshot } from "../frontend/models/document";
import type { LocalDraft } from "../frontend/models/drafts";
import { createAuthenticationSession } from "../frontend/state/authentication";
import { createDocumentSession } from "../frontend/state/document";
import { createDocumentSaver } from "../frontend/services/document-saving";
import { createDraftRecovery } from "../frontend/services/draft-recovery";

type Ports = Parameters<typeof createDraftRecovery>[0];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(overrides: Partial<Ports> = {}, write?: (snapshot: SaveSnapshot) => Promise<DocumentPayload>) {
  const owner = new AbortController();
  const authentication = createAuthenticationSession();
  authentication.initialize("users", { username: "alice", id: "alice-id", scope: "service", role: "user" });
  const session = createDocumentSession();
  const payload: DocumentPayload = {
    id: "01961e0b-9831-7000-8000-000000000001",
    project: "notes",
    path: "Note.md",
    content: "original\n",
    html: null,
    version: "original",
  };
  session.open({ ...createDocumentModel(payload), root: "notes" });
  const editor = { text: payload.content };
  const writes: SaveSnapshot[] = [];
  const removed: LocalDraft[] = [];
  const problem: unknown[] = [];
  const saver = createDocumentSaver({
    signal: owner.signal,
    session,
    text: () => editor.text,
    read: async () => ({ ...payload, version: "fresh", content: "latest disk\n" }),
    write:
      write ??
      (async (snapshot) => {
        writes.push(snapshot);
        return { ...payload, content: snapshot.content, version: "saved" };
      }),
    classify: (cause) => ({
      error: cause instanceof Error ? cause : new Error(String(cause)),
      conflict: false,
      uncertain: cause instanceof Error && cause.message === "timeout",
    }),
    accepted: (_checkpoint, _payload, result) => {
      editor.text = result.text;
    },
    changed() {},
    settled() {},
    problem: (error) => problem.push(error),
  });
  const record: LocalDraft = {
    project: "notes",
    document: payload.id,
    path: payload.path,
    source: "recovered\n",
    version: "older",
    room: null,
    updates: "",
    unmerged: false,
    selection: null,
    tab: "old-tab",
    keep: true,
    key: "a".repeat(64),
    generation: "b".repeat(32),
    updated: 1,
  };
  const workflow = createDraftRecovery({
    signal: owner.signal,
    scope: () => authentication.scope,
    session,
    project: () => "notes",
    shared: () => null,
    canWrite: () => true,
    confirm: async () => true,
    read: async () => ({ ...payload, version: "fresh", content: "latest disk\n" }),
    applySource: (text) => {
      editor.text = text;
      session.edited();
    },
    save: () => saver.save(),
    persistShared: async () => {},
    remove: async (record) => {
      removed.push(record);
    },
    cancelAutoSave() {},
    resumeAutoSave() {},
    ...overrides,
  });
  return { owner, authentication, session, payload, editor, writes, removed, record, saver, workflow };
}

test("solo recovery uses the latest version and shared save reconciliation without replacing the document session", async () => {
  const app = setup();
  const id = app.session.id;
  assert.equal(await app.workflow.apply(app.record), "applied");
  assert.equal(app.writes[0].version, "fresh");
  assert.equal(app.writes[0].content, app.record.source);
  assert.equal(app.session.id, id);
  assert.equal(app.session.current?.version, "saved");
  assert.equal(app.editor.text, app.record.source);
  assert.deepEqual(app.removed, [app.record]);
});

test("a failed save keeps the staged text and original recovery copy", async () => {
  const app = setup({}, async () => {
    throw new Error("Save unavailable");
  });
  assert.equal(await app.workflow.apply(app.record), "unsaved");
  assert.equal(app.editor.text, app.record.source);
  assert.equal(app.session.analyze(app.editor.text).changed, true);
  assert.equal(app.removed.length, 0);
});

test("a document replacement cancels recovery while a non-canceling gateway still holds the old response", async () => {
  const response = deferred<DocumentPayload>();
  const started = deferred<void>();
  const app = setup({
    read: () => {
      started.resolve();
      return response.promise;
    },
  });
  const recovering = app.workflow.apply(app.record);
  await started.promise;
  app.session.open({
    ...createDocumentModel({ ...app.payload, id: "01961e0b-9831-7000-8000-000000000002" }),
    root: "notes",
  });
  assert.equal(await recovering, "canceled");
  response.resolve({ ...app.payload, version: "obsolete" });
  await Promise.resolve();
  assert.equal(app.writes.length, 0);
  assert.equal(app.removed.length, 0);
  assert.equal(app.editor.text, "original\n");
});

test("continued editing invalidates confirmation before recovery can overwrite newer input", async () => {
  const answer = deferred<boolean>();
  const app = setup({ confirm: () => answer.promise });
  const recovering = app.workflow.apply(app.record);
  app.editor.text = "still typing";
  app.session.edited();
  assert.equal(await recovering, "canceled");
  answer.resolve(true);
  assert.equal(app.editor.text, "still typing");
  assert.equal(app.writes.length, 0);
});

test("canceling a recovery intent resumes autosave only for its still-owned document", async () => {
  const answer = deferred<boolean>();
  const scheduler = { paused: 0, resumed: 0 };
  const app = setup({
    confirm: () => answer.promise,
    cancelAutoSave: () => {
      scheduler.paused++;
    },
    resumeAutoSave: () => {
      scheduler.resumed++;
    },
  });
  const recovering = app.workflow.apply(app.record);
  app.workflow.cancel();
  assert.equal(await recovering, "canceled");
  assert.deepEqual(scheduler, { paused: 1, resumed: 1 });
  answer.resolve(false);
  app.owner.abort();
  assert.equal(await app.workflow.apply(app.record), "canceled");
  assert.deepEqual(scheduler, { paused: 1, resumed: 1 });
});

test("credential cancellation stops recovery cleanup without canceling the actual save promise", async () => {
  const saved = deferred<boolean>();
  const started = deferred<void>();
  const app = setup({
    save: () => {
      started.resolve();
      return saved.promise;
    },
  });
  const recovering = app.workflow.apply(app.record);
  await started.promise;
  app.authentication.beginAuthentication();
  assert.equal(await recovering, "canceled");
  saved.resolve(true);
  await Promise.resolve();
  assert.equal(app.removed.length, 0);
  assert.equal(app.editor.text, app.record.source);
});

test("shared recovery retains the original copy until the replacement local draft is durable", async () => {
  const persisted = deferred<void>();
  const started = deferred<void>();
  const shared = {};
  const app = setup({
    shared: () => shared,
    read: async () => {
      throw new Error("Shared recovery must not read or write the solo disk path.");
    },
    persistShared: () => {
      started.resolve();
      return persisted.promise;
    },
  });
  const recovering = app.workflow.apply(app.record);
  await started.promise;
  assert.equal(app.removed.length, 0);
  assert.equal(app.writes.length, 0);
  persisted.resolve();
  assert.equal(await recovering, "applied");
  assert.deepEqual(app.removed, [app.record]);
});

test("an explicitly refreshed recovery baseline supersedes a previous unconfirmed save", async () => {
  let writes = 0;
  const submitted: SaveSnapshot[] = [];
  const app = setup({}, async (snapshot) => {
    submitted.push(snapshot);
    if (++writes === 1) throw new Error("timeout");
    return { ...app.payload, content: snapshot.content, version: "saved" };
  });
  app.editor.text = "unconfirmed\n";
  app.session.edited();
  assert.equal(await app.saver.save(), false);
  assert.equal(await app.workflow.apply(app.record), "applied");
  assert.equal(submitted[1].version, "fresh");
  assert.equal(app.session.conflict, false);
  assert.equal(app.editor.text, app.record.source);
});
