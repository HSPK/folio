import test from "node:test";
import assert from "node:assert/strict";
import { createDocumentModel } from "../frontend/models/document";
import { createDocumentSession } from "../frontend/state/document";

const payload = {
  id: "01961e0b-9831-7000-8000-000000000001",
  path: "Note.md",
  content: "---\r\ntitle: Original\r\n---\r\nBody\r\n",
  html: null,
  version: "initial",
  title: "Original",
};

test("replacing or remounting a document invalidates old loads and acknowledgements even for the same resource", () => {
  const session = createDocumentSession();
  session.open({ ...createDocumentModel(payload), root: "notes" });
  const checkpoint = session.checkpoint("first edit");
  const opening = session.beginLoad("pop");
  session.close();
  session.open({ ...createDocumentModel(payload), root: "notes" });
  assert.notEqual(session.id, checkpoint.id);
  assert.equal(opening.controller.signal.aborted, true);
  assert.equal(session.isCurrentLoad(opening), false);
  assert.equal(session.acceptSaved(checkpoint, { ...payload, version: "obsolete" }, "first edit"), null);
  assert.equal(session.current?.version, "initial");
  const other = createDocumentSession();
  other.open({ ...createDocumentModel(payload), root: "notes" });
  assert.notEqual(other.id, session.id);
});

test("save acknowledgement advances the baseline without replacing newer text or metadata", () => {
  const session = createDocumentSession();
  session.open({ ...createDocumentModel(payload), root: "notes" });
  const checkpoint = session.checkpoint("submitted\n");
  session.edited();
  session.setTitle("Still typing");
  const result = session.acceptSaved(
    checkpoint,
    { ...payload, content: "submitted\r\n", version: "saved" },
    "submitted\nnewer\n",
  );
  assert.ok(result);
  assert.equal(result.text, "submitted\nnewer\n");
  assert.equal(result.dirty, true);
  assert.equal(session.current?.title, "Still typing");
  assert.equal(session.current?.version, "saved");
  assert.equal(session.checkpoint(result.text).snapshot.content, "submitted\r\nnewer\r\n");
  assert.equal(session.analyze(result.text).changed, true);
});

test("shared baselines invalidate cached dirty analysis and session documents cannot be mutated by consumers", () => {
  const session = createDocumentSession();
  const model = { ...createDocumentModel(payload), root: "notes" };
  session.open(model);
  model.format.lineEnding = "\n";
  assert.equal(session.current?.format.lineEnding, "\r\n");
  assert.equal(Object.isFrozen(session.current), true);
  assert.equal(session.analyze("remote\n").changed, true);
  session.acceptRemote({ ...payload, content: "remote\r\n", version: "remote" }, "notes");
  assert.equal(session.analyze("remote\n").changed, false);
  assert.throws(() => session.acceptRemote({ ...payload, id: "other" }, "notes"), /current document/);
});

test("late save cleanup cannot release a newer operation or carry conflict into a replacement document", () => {
  const session = createDocumentSession();
  session.open({ ...createDocumentModel(payload), root: "notes" });
  const previous = { ...session.checkpoint("old\n"), completion: Promise.resolve(true) };
  session.beginSave(previous);
  session.markConflict();
  session.open({ ...createDocumentModel(payload), root: "notes" });
  const current = { ...session.checkpoint("new\n"), completion: Promise.resolve(true) };
  session.beginSave(current);
  assert.equal(session.conflict, false);
  assert.equal(session.finishSave(previous), false);
  assert.equal(session.saving, current);
  assert.equal(session.finishSave(current), true);
});
