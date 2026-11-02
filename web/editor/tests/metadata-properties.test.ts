import test from "node:test";
import assert from "node:assert/strict";
import { parseDocument } from "yaml";
import { replaceYamlProperty } from "../src/metadata-properties.ts";
import { readableMarkdown } from "../src/markdown.ts";

test("editing common properties preserves comments, other fields and mixed line endings", () => {
  const raw = "# Keep\r\ntitle: 'Original' # label\nstatus: draft\r\ncustom: {x: 1}\n";
  const next = replaceYamlProperty(raw, "title", "Writer's title");
  assert.equal(next, raw.replace("'Original'", "'Writer''s title'"));
  assert.equal(replaceYamlProperty(next, "status", "review"), next.replace("status: draft", 'status: "review"'));
  assert.equal(replaceYamlProperty(raw, "title", "Original"), raw);
});

test("property text stays a scalar, and adding a field retains the source newline convention", () => {
  for (const ending of ["\n", "\r\n", "\r"]) {
    const raw = `custom: {x: 1}${ending}`;
    const next = replaceYamlProperty(raw, "title", "true: # not YAML");
    assert.equal(next, `${raw}title: "true: # not YAML"${ending}`);
    assert.equal(parseDocument(next.replace(/\r\n?/g, "\n")).get("title"), "true: # not YAML");
  }
  assert.equal(replaceYamlProperty("", "status", ""), "");
  assert.equal(replaceYamlProperty("title: null\n", "title", "New"), 'title: "New"\n');
  assert.equal(replaceYamlProperty("title:\n", "title", "New"), 'title: "New"\n');
});

test("structured, anchored, duplicate and invalid metadata cannot be overwritten by property fields", () => {
  for (const raw of [
    "title: [one, two]\n",
    "title: &name Original\nalias: *name\n",
    "title: one\ntitle: two\n",
    "title: [unfinished",
    "- title\n",
    "title: |\n  two\n  lines\n",
  ]) {
    assert.throws(() => replaceYamlProperty(raw, "title", "New"));
  }
  assert.throws(() => replaceYamlProperty("{custom: 1}\n", "title", "New"));
  assert.equal(
    replaceYamlProperty('{title: "Before", custom: 1}\n', "title", "After"),
    '{title: "After", custom: 1}\n',
  );
});

test("search snippets use readable Markdown without URLs, markup or executable HTML", () => {
  assert.equal(
    readableMarkdown("# Heading\n\nA **bold** [link](https://example.com).\n\n- item\n"),
    "Heading\nA bold link.\nitem",
  );
  assert.equal(
    readableMarkdown("![Plot](image.png)\n\n[[Other|Related note]] and `code`."),
    "Plot\nRelated note and code.",
  );
  assert.equal(readableMarkdown("<script>alert('no')</script>\n\nSafe text."), "Safe text.");
});
