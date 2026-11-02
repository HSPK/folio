import test from "node:test";
import assert from "node:assert/strict";
import { createDraftRepository, createDraftWriteQueue } from "../frontend/services/draft-repository";
import { decodedDraft, decodedEncryptedDraft, type DraftStore, type EncryptedDraft } from "../frontend/models/drafts";

const identity = { scope: "legacy-test-service:alice", secret: "01".repeat(32) };
const snapshot = {
  keep: true,
  project: "notes",
  document: "01961e0b-9831-7000-8000-000000000001",
  path: "Legacy.md",
  source: "# Stored legacy draft\n",
  version: "disk-v1",
  room: null,
  updates: "",
  unmerged: false,
  selection: { from: 0, to: 0 },
  tab: "legacy-tab",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function storage(rows = new Map<string, EncryptedDraft>(), overrides: Partial<DraftStore> = {}) {
  const state = { closed: false };
  const store: DraftStore = {
    byOwner: async (owner) => [...rows.values()].filter((row) => row.owner === owner),
    byDocument: async (document) => [...rows.values()].filter((row) => row.document === document),
    put: async (record) => {
      if (state.closed) throw new Error("Storage closed before its accepted write.");
      rows.set(record.key, record);
    },
    remove: async (key, owner, generation) => {
      const current = rows.get(key);
      if (!current) return;
      if (current.owner !== owner) throw new Error("This recovery copy belongs to a different account.");
      if (!generation || current.generation === generation) rows.delete(key);
    },
    close: async () => {
      state.closed = true;
    },
    ...overrides,
  };
  return { rows, state, store };
}

test("legacy version-one ciphertext and key derivation remain readable", async () => {
  const record: EncryptedDraft = {
    key: "5de4e52d34ef488b59917610437d2dbbca6ecd96fefd3de2a38b132855ff82e9",
    document: "57361ea58fa9c68514dc782c8f63cc37253e9f5e118a01d4434e6f432c672cf6",
    owner: "edc4fec73cfea295b30ad34cf1c2e993781516727d15f0d69f89ffa47a18abfd",
    generation: "0".repeat(32),
    updated: 1,
    compressed: false,
    iv: Uint8Array.from({ length: 12 }, (_, index) => index),
    payload: Uint8Array.from(
      Buffer.from(
        "4WRfcrGEQbdtgukzg79oTSfjfxCMI3ezTMKIjauXVhf1BG9QrV48j25DXIo0DSkHxEXAxnUOYUg3dXCI0FGEdymgGDTTSmmvu87ISxWjTIGZ743AC/9W5xzh/Mc1AtGFOqXTrzMkffie7/oIGAlWHhNgUZwteFrtMUR4TF62eujxhBCM9cJBlHGaWg2ABwfJ6Y+RbEf3/kd7dmkEeuEHreg1IGmpVHoyHOS8+C7QcWo6D0xkA1+UByW5Hg0kGUS8E+pIqfvKnqE+Nba2Mb3JdKmm6sOSFo7hvdEfVuP7/n6u4nPnCiCipnngO70h8tgBGRr0SIsLS9d6+ocNwiuOnsOkxk1t4w==",
        "base64",
      ),
    ).buffer,
  };
  for (const legacy of [record, { ...record, payload: new Blob([record.payload]) }]) {
    const memory = storage(new Map([[legacy.key, legacy]]));
    const repository = createDraftRepository(memory.store);
    const recovered = await repository.owner(identity).forDocument(snapshot.project, snapshot.document);
    assert.equal(recovered?.source, snapshot.source);
    assert.equal(recovered?.version, snapshot.version);
    assert.deepEqual(recovered?.selection, snapshot.selection);
    await repository.close();
  }
});

test("owners and queued snapshots are captured before identity or source objects can change", async () => {
  const memory = storage();
  const repository = createDraftRepository(memory.store);
  const input = { ...identity };
  const owner = repository.owner(input);
  const draft = { ...snapshot, selection: { from: 1, to: 2 } };
  const saving = owner.persist(draft);
  input.scope = "another-account";
  input.secret = "02".repeat(32);
  draft.source = "mutated";
  draft.selection.from = 99;
  await saving;
  const recovered = await owner.forDocument(snapshot.project, snapshot.document);
  assert.equal(recovered?.source, snapshot.source);
  assert.deepEqual(recovered?.selection, { from: 1, to: 2 });
  const stranger = repository.owner(input);
  assert.equal(await stranger.forDocument(snapshot.project, snapshot.document), null);
  const record = memory.rows.values().next().value;
  assert.ok(record);
  await assert.rejects(stranger.remove(record.key), /different account/);
  assert.equal(memory.rows.size, 1);
  await repository.close();
});

test("closing drains already accepted writes but rejects new work before closing storage", async () => {
  const held = deferred<void>();
  const started = deferred<void>();
  const memory = storage();
  const original = memory.store.put;
  memory.store.put = async (record) => {
    started.resolve();
    await held.promise;
    await original(record);
  };
  const repository = createDraftRepository(memory.store);
  const owner = repository.owner(identity);
  const write = owner.persist(snapshot);
  const closing = repository.close();
  await started.promise;
  assert.equal(memory.state.closed, false);
  await assert.rejects(owner.persist(snapshot), /repository is closed/);
  held.resolve();
  await Promise.all([write, closing]);
  assert.equal(memory.state.closed, true);
  assert.equal(memory.rows.size, 1);
  const reopened = createDraftRepository(storage(memory.rows).store);
  assert.equal(
    (await reopened.owner(identity).forDocument(snapshot.project, snapshot.document))?.source,
    snapshot.source,
  );
  await reopened.close();
});

test("generation-safe cleanup cannot remove a newer write and a failed write does not poison later intent", async () => {
  let writes = 0;
  const memory = storage();
  const put = memory.store.put;
  memory.store.put = async (record) => {
    if (++writes === 1) throw new Error("Temporary storage failure");
    await put(record);
  };
  const repository = createDraftRepository(memory.store);
  const owner = repository.owner(identity);
  await assert.rejects(owner.persist(snapshot), /Temporary storage failure/);
  await owner.persist(snapshot);
  const first = memory.rows.values().next().value;
  assert.ok(first);
  await owner.persist({ ...snapshot, source: "newer" });
  await owner.remove(first.key, first.generation);
  assert.equal((await owner.forDocument(snapshot.project, snapshot.document))?.source, "newer");
  await repository.close();
});

test("overlapping application lifetimes keep accepted writes ordered across separately owned connections", async () => {
  const writes = createDraftWriteQueue();
  const held = deferred<void>();
  const started = deferred<void>();
  const oldStore = storage();
  const put = oldStore.store.put;
  oldStore.store.put = async (record) => {
    started.resolve();
    await held.promise;
    await put(record);
  };
  const previous = createDraftRepository(oldStore.store, writes);
  const oldWrite = previous.owner(identity).persist(snapshot);
  const closing = previous.close();
  const nextStore = storage(oldStore.rows);
  const next = createDraftRepository(nextStore.store, writes);
  const newWrite = next.owner(identity).persist({ ...snapshot, source: "new application text" });
  await started.promise;
  assert.equal(nextStore.rows.size, 0);
  held.resolve();
  await Promise.all([oldWrite, closing, newWrite]);
  assert.equal(
    (await next.owner(identity).forDocument(snapshot.project, snapshot.document))?.source,
    "new application text",
  );
  await next.close();
});

test("decrypted and IndexedDB records are fully decoded instead of leaking unchecked JSON", () => {
  assert.throws(() => decodedDraft({ ...snapshot, document: "Legacy.md" }), /recovery record is invalid/);
  assert.throws(() => decodedDraft({ ...snapshot, updates: "not base64" }), /recovery record is invalid/);
  assert.throws(() => decodedDraft({ ...snapshot, unmerged: "false" }), /recovery record is invalid/);
  assert.throws(() => decodedDraft({ ...snapshot, selection: { from: 1, to: "2" } }), /selection is invalid/);
  assert.throws(() => decodedEncryptedDraft({ key: "wrong" }), /encrypted recovery record is invalid/);
  assert.equal(decodedDraft({ ...snapshot, selection: { from: 10, to: 1 } }).selection?.to, 1);
});
