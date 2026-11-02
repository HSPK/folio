import test from "node:test";
import assert from "node:assert/strict";
import { createProjectModel } from "../frontend/state/projects";

function project(id = "first") {
  return {
    id,
    name: id,
    owned: true,
    root: `/notes/${id}`,
    imageDirectory: "images",
    shared: "private" as const,
    pages: { "Note.md": "read" as const },
    documentIds: { "Note.md": "resource" },
    publicLinks: { "Note.md": { token: "link", access: "read" as const, passwordRequired: false } },
  };
}

test("the project registry owns immutable records and mutations update the addressed project without changing selection", () => {
  const model = createProjectModel();
  model.bindOwner("alice");
  const raw = project();
  model.replace(model.request(), [raw, project("second")]);
  model.select("second");
  raw.name = "mutated input";
  raw.publicLinks["Note.md"].token = "mutated link";
  model.commit(model.request(), { ...project(), name: "Saved first" });
  assert.equal(model.active?.id, "second");
  assert.equal(model.get("first")?.name, "Saved first");
  assert.equal(model.get("first")?.publicLinks?.["Note.md"].token, "link");
  assert.equal(Object.isFrozen(model.get("first")?.pages), true);
});

test("catalog and session snapshots cannot roll back newer project writes or a different selection", () => {
  const model = createProjectModel();
  model.bindOwner("alice");
  model.replace(model.request(), [project(), project("second")]);
  model.select("first");
  const oldList = model.request();
  const oldSession = model.request();
  model.commit(model.request(), { ...project(), name: "New name" });
  assert.equal(model.replace(oldList, [project()]), false);
  assert.equal(model.acceptSession(oldSession, project()), false);
  assert.throws(() => model.acceptSession(oldSession, project("second")), /different project session/);
  const selected = model.request();
  model.select("second");
  assert.equal(model.acceptSession(selected, project()), false);
  assert.equal(model.active?.id, "second");
  assert.equal(model.get("first")?.name, "New name");
});

test("account rebinding rejects previous requests and resets selected project ownership", () => {
  const model = createProjectModel();
  model.bindOwner("alice");
  model.replace(model.request(), [project()]);
  model.select("first");
  const previous = model.request();
  model.bindOwner("bob");
  assert.equal(model.active, null);
  assert.equal(model.replace(previous, [project()]), false);
  assert.throws(() => model.commit(previous, project()), { name: "AbortError" });
  assert.equal(model.items.length, 0);
});
