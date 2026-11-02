import test from "node:test";
import assert from "node:assert/strict";
import { filterNotes } from "../frontend/models/library";
import { createLibraryModel } from "../frontend/state/library";
import { decodedTree } from "../frontend/api/contracts";

test("search caches never mutate library entries owned by an immutable view or API snapshot", () => {
  const entry = new Proxy(
    { path: "Notes/Plan.md", name: "Plan.md", title: "Roadmap" },
    {
      set() {
        throw new Error("The view does not own this record.");
      },
      defineProperty() {
        throw new Error("The view does not own this record.");
      },
    },
  );
  assert.deepEqual(filterNotes([entry], "roadmap"), [entry]);
  assert.deepEqual(filterNotes([entry], "plan"), [entry]);
  assert.deepEqual(Object.getOwnPropertySymbols(entry), []);
});

test("catalog selection follows document identity instead of selecting a new file at an old path", () => {
  const first = "01961e0b-9831-7000-8000-000000000001";
  const replacement = "01961e0b-9831-7000-8000-000000000002";
  const model = createLibraryModel();
  model.replace([{ id: first, path: "Note.md", name: "Note.md" }], [], false);
  model.project(model.catalog.files, model.catalog.directories, "");
  model.select({ id: first, path: "Note.md" });
  model.replace(
    [
      { id: replacement, path: "Note.md", name: "Note.md" },
      { id: first, path: "Moved/Original.md", name: "Original.md" },
    ],
    [],
    false,
  );
  model.project(model.catalog.files, model.catalog.directories, "");
  const original = model.catalog.files.find((file) => file.id === first);
  const newer = model.catalog.files.find((file) => file.id === replacement);
  assert.ok(original && newer);
  assert.equal(model.selected(original), true);
  assert.equal(model.selected(newer), false);
});

test("filter reveal and catalog reset retain one source of selection and release stale context", () => {
  const model = createLibraryModel();
  const id = "01961e0b-9831-7000-8000-000000000001";
  model.replace([{ id, path: "Folder/Current.md", name: "Current.md" }], [], false);
  model.setCollapsed("Folder", true);
  model.project(model.catalog.files, model.catalog.directories, "missing");
  model.select({ id, path: "Folder/Current.md" });
  assert.equal(model.view.outsideFilter, true);
  model.focusCurrent();
  assert.equal(model.catalog.collapsedFolders.has("Folder"), false);
  assert.ok(model.view.focusRequest);
  model.reset();
  assert.equal(model.catalog.files.length, 0);
  assert.equal(model.view.outsideFilter, false);
  assert.equal(model.view.focusRequest, null);
});

test("tree decoding preserves resource identity and rejects ambiguous normalized paths", () => {
  const file = { id: "01961e0b-9831-7000-8000-000000000001", path: "Folder\\Note.md", name: "Note.md" };
  const tree = { root: "root", files: [file], directories: [], truncated: false };
  assert.equal(decodedTree(tree).files[0].id, file.id);
  assert.equal(decodedTree(tree).files[0].path, "Folder/Note.md");
  assert.throws(
    () => decodedTree({ ...tree, files: [file, { ...file, path: "Folder/Note.md" }] }),
    /duplicate library paths/,
  );
});

test("catalog reconciliation owns its records without modifying the API snapshots it received", () => {
  const model = createLibraryModel();
  const incoming = Object.freeze({ path: "Note.md", name: "Note.md", title: "First" });
  model.replace([incoming], [], false);
  model.replace([{ ...incoming, title: "Changed" }], [], false);
  assert.equal(incoming.title, "First");
  assert.equal(model.catalog.files[0].title, "Changed");
});
