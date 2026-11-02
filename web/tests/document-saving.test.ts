import test from "node:test";
import assert from "node:assert/strict";
import { createDocumentModel, type DocumentPayload, type SaveSnapshot } from "../frontend/models/document";
import { createDocumentSession } from "../frontend/state/document";
import { createDocumentSaver, type SaveProblem } from "../frontend/services/document-saving";

type Ports = Parameters<typeof createDocumentSaver>[0];

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
  const session = createDocumentSession();
  const owner = new AbortController();
  const document: DocumentPayload = {
    id: "01961e0b-9831-7000-8000-000000000001",
    path: "Note.md",
    content: "original\n",
    html: null,
    version: "initial",
  };
  session.open({ ...createDocumentModel(document), root: "notes" });
  const editor = { text: "submitted\n" };
  const problems: SaveProblem[] = [];
  const writes: SaveSnapshot[] = [];
  const settlements: { completed: boolean; requested: boolean }[] = [];
  const saver = createDocumentSaver({
    signal: owner.signal,
    session,
    text: () => editor.text,
    read: async () => document,
    write: async (snapshot) => {
      writes.push(snapshot);
      return { ...document, content: snapshot.content, version: "saved" };
    },
    classify: (cause) => ({
      error: cause instanceof Error ? cause : new Error(String(cause)),
      conflict: cause instanceof Error && cause.message === "conflict",
      uncertain: cause instanceof Error && cause.message === "timeout",
    }),
    accepted: (_checkpoint, _payload, result) => {
      editor.text = result.text;
    },
    changed() {},
    problem: (problem) => problems.push(problem),
    settled: (_checkpoint, completed, requested) => settlements.push({ completed, requested }),
    ...overrides,
  });
  return { session, owner, document, editor, saver, problems, writes, settlements };
}

test("manual saves share one request and preserve both newer edits and explicit follow-up intent", async () => {
  const response = deferred<DocumentPayload>();
  const app = setup({ write: () => response.promise });
  const saving = app.saver.save();
  app.editor.text += "newer\n";
  app.session.edited();
  assert.equal(app.saver.save(), saving);
  response.resolve({ ...app.document, content: "submitted\n", version: "saved" });
  assert.equal(await saving, true);
  assert.equal(app.editor.text, "submitted\nnewer\n");
  assert.equal(app.session.current?.version, "saved");
  assert.equal(app.session.analyze(app.editor.text).changed, true);
  assert.deepEqual(app.settlements, [{ completed: true, requested: true }]);
});

test("an uncertain committed save is verified before retrying newer text with the acknowledged version", async () => {
  let attempts = 0;
  const snapshots: SaveSnapshot[] = [];
  const app = setup({
    read: async () => ({ ...app.document, content: "submitted\n", version: "committed" }),
    write: async (snapshot) => {
      snapshots.push(snapshot);
      if (++attempts === 1) throw new Error("timeout");
      return { ...app.document, content: snapshot.content, version: "latest" };
    },
  });
  assert.equal(await app.saver.save(), false);
  app.editor.text += "newer\n";
  app.session.edited();
  assert.equal(await app.saver.save(), true);
  assert.equal(snapshots[1].version, "committed");
  assert.equal(snapshots[1].content, "submitted\nnewer\n");
  assert.equal(app.session.analyze(app.editor.text).changed, false);
});

test("verification accepts a committed acknowledgement without issuing a duplicate write", async () => {
  let writes = 0;
  const app = setup({
    read: async () => ({ ...app.document, content: "submitted\n", version: "committed" }),
    write: async () => {
      writes++;
      throw new Error("timeout");
    },
  });
  assert.equal(await app.saver.save(), false);
  assert.equal(await app.saver.save(), true);
  assert.equal(writes, 1);
  assert.equal(app.session.current?.version, "committed");
});

test("an external edit after an uncertain save becomes a conflict instead of being overwritten", async () => {
  let writes = 0;
  const app = setup({
    read: async () => ({ ...app.document, content: "external\n", version: "external" }),
    write: async () => {
      writes++;
      throw new Error("timeout");
    },
  });
  assert.equal(await app.saver.save(), false);
  assert.equal(await app.saver.save(), false);
  assert.equal(writes, 1);
  assert.equal(app.session.conflict, true);
  assert.equal(app.editor.text, "submitted\n");
  assert.equal(app.problems.at(-1)?.kind, "conflict");
});

test("a previous write committing between verification and retry is reconciled before another write is requested", async () => {
  let writes = 0;
  let reads = 0;
  const app = setup({
    read: async () =>
      ++reads === 1 ? app.document : { ...app.document, content: "submitted\n", version: "committed" },
    write: async () => {
      if (++writes === 1) throw new Error("timeout");
      throw new Error("conflict");
    },
  });
  assert.equal(await app.saver.save(), false);
  app.editor.text += "newer\n";
  app.session.edited();
  assert.equal(await app.saver.save(), true);
  assert.equal(reads, 2);
  assert.equal(app.session.current?.version, "committed");
  assert.equal(app.session.conflict, false);
  assert.equal(app.editor.text, "submitted\nnewer\n");
  assert.deepEqual(app.settlements.at(-1), { completed: true, requested: true });
});

test("retry revalidates the newest text after verification rather than submitting an oversized replacement", async () => {
  const verifying = deferred<DocumentPayload>();
  let writes = 0;
  const app = setup({
    read: () => verifying.promise,
    write: async () => {
      writes++;
      throw new Error("timeout");
    },
  });
  assert.equal(await app.saver.save(), false);
  const retry = app.saver.save();
  app.editor.text = "x".repeat(4 * 1024 * 1024 + 1);
  app.session.edited();
  verifying.resolve({ ...app.document, content: "submitted\n", version: "committed" });
  assert.equal(await retry, false);
  assert.equal(writes, 1);
  assert.equal(app.problems.at(-1)?.kind, "too-large");
  assert.equal(app.editor.text.length, 4 * 1024 * 1024 + 1);
});

test("owner disposal settles pending saving even when a transport ignores cancellation", async () => {
  const response = deferred<DocumentPayload>();
  const app = setup({ write: () => response.promise });
  const saving = app.saver.save();
  app.owner.abort();
  assert.equal(await saving, false);
  assert.equal(app.session.saving, null);
  assert.equal(app.problems.length, 0);
  assert.equal(app.settlements.length, 0);
  response.reject(new Error("late transport rejection"));
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("a late acknowledgement cannot affect the same resource reopened in a new session", async () => {
  const response = deferred<DocumentPayload>();
  const app = setup({ write: () => response.promise });
  const saving = app.saver.save();
  app.session.close();
  app.session.open({ ...createDocumentModel(app.document), root: "notes" });
  response.resolve({ ...app.document, content: "submitted\n", version: "obsolete" });
  assert.equal(await saving, false);
  assert.equal(app.session.current?.version, "initial");
  assert.equal(app.problems.length, 0);
  assert.equal(app.settlements.length, 0);
});
