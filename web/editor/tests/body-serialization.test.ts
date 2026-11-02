import test from "node:test";
import assert from "node:assert/strict";
import { Schema, type Node } from "@milkdown/prose/model";
import { unified, type Plugin } from "unified";
import {
  createBodyCache,
  createBodySerializer,
  reuseParsedBody,
  serializedBodyTree,
} from "../src/body-serialization.ts";
import { parseBody } from "../src/markdown.ts";
import type { Root } from "mdast";

test("body parsing cache is bounded, recent-use ordered and explicitly clearable", () => {
  const cache = createBodyCache();
  const entries = Array.from({ length: 5 }, (_, index) => {
    const source = `# Body ${index}\n`;
    const tree = parseBody(source);
    return {
      source,
      value: {
        tree,
        model: source,
        serialized: source,
        serializedTree: tree,
        documentJSON: { type: "doc", content: [{ type: "paragraph" }] },
      },
    };
  });
  for (const entry of entries.slice(0, 4)) cache.set(entry.source, entry.value);
  assert.equal(cache.get(entries[0].source), entries[0].value);
  cache.set(entries[4].source, entries[4].value);
  assert.equal(cache.get(entries[1].source), null);
  assert.equal(cache.get(entries[0].source), entries[0].value);
  const large = "x".repeat(512 * 1024 + 1);
  cache.set(large, entries[0].value);
  assert.equal(cache.get(large), null);
  cache.set("heavy", { ...entries[0].value, model: "x".repeat(8 * 1024 * 1024) });
  assert.equal(cache.get("heavy"), null);
  cache.clear();
  assert.equal(cache.get(entries[4].source), null);
});

test("reusing a prepared body avoids reparsing without sharing remark mutations", () => {
  const source = "# Original\n\nA paragraph.\n";
  const tree = parseBody(source);
  let parses = 0;
  const parse: Plugin<[], string, Root> = function () {
    this.parser = (text) => {
      parses++;
      return parseBody(text);
    };
  };
  const processor = unified().use(parse).use(reuseParsedBody({ source, tree }));
  const first = processor.parse(source);
  assert.equal(first.children[0].type, "heading");
  assert.equal(first.children[0].children[0].type, "text");
  first.children[0].children[0].value = "Editor transform";
  const reused = processor.parse(source).children[0];
  assert.equal(reused.type, "heading");
  assert.equal(reused.children[0].type, "text");
  assert.equal(reused.children[0].value, "Original");
  assert.equal(tree.children[0].type, "heading");
  assert.equal(tree.children[0].children[0].type, "text");
  assert.equal(tree.children[0].children[0].value, "Original");
  assert.equal(parses, 0);
  const different = processor.parse("# Different\n").children[0];
  assert.equal(different.type, "heading");
  assert.equal(different.children[0].type, "text");
  assert.equal(different.children[0].value, "Different");
  assert.equal(parses, 1);
});

test("serialization proof reuses trailing whitespace only outside syntax nodes", () => {
  const source = "# Heading\n\nBody.\n\n\n";
  const tree = parseBody(source);
  assert.equal(serializedBodyTree({ source, tree, serialized: source.replace(/\n+$/, "\n") }), tree);
  const changed = "# Heading\n\nChanged.\n";
  assert.deepEqual(serializedBodyTree({ source, tree, serialized: changed }), parseBody(changed));
  for (const source of ["```text\nliteral\n\n", "<script>literal\n\n"]) {
    const tree = parseBody(source);
    const serialized = source.replace(/\n+$/, "\n");
    assert.notEqual(serializedBodyTree({ source, tree, serialized }), tree);
    assert.deepEqual(serializedBodyTree({ source, tree, serialized }), parseBody(serialized));
  }
});

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "text*", group: "block" },
    heading: { content: "text*", group: "block", attrs: { level: { default: 1 } } },
    blockquote: { content: "block+", group: "block" },
    text: { group: "inline" },
  },
});
const paragraph = (text: string) => schema.node("paragraph", null, text ? schema.text(text) : []);
const heading = (text: string) => schema.node("heading", { level: 2 }, schema.text(text));
const document = (...nodes: Node[]) => schema.node("doc", null, nodes);
const serialize = (doc: Node) => {
  const blocks: string[] = [];
  doc.forEach((node) =>
    blocks.push(
      node.type.name === "heading"
        ? `## ${node.textContent}`
        : node.type.name === "blockquote"
          ? `> ${node.textContent}`
          : node.textContent,
    ),
  );
  return blocks.join("\n\n") + "\n";
};

test("body edits serialize only the changed block and keep following source offsets accurate", () => {
  const title = heading("Title");
  const first = paragraph("First");
  const last = paragraph("Last");
  const original = document(title, first, last);
  const calls: number[] = [];
  const serializer = createBodySerializer({
    document: original,
    source: serialize(original),
    serialize_fn: (doc) => {
      calls.push(doc.childCount);
      return serialize(doc);
    },
  });
  const expanded = paragraph("A much longer first paragraph");
  const next = document(title, expanded, last);
  assert.equal(serializer.serialize(next), serialize(next));
  const final = document(title, expanded, paragraph("Last changed"));
  assert.equal(serializer.serialize(final), serialize(final));
  assert.deepEqual(calls, [1, 1]);
});

test("splitting and joining paragraphs replaces only their shared source range", () => {
  const before = paragraph("Before");
  const after = paragraph("After");
  const original = document(before, paragraph("One two"), after);
  const calls: number[] = [];
  const serializer = createBodySerializer({
    document: original,
    source: serialize(original),
    serialize_fn: (doc) => {
      calls.push(doc.childCount);
      return serialize(doc);
    },
  });
  const split = document(before, paragraph("One"), paragraph("Two"), after);
  assert.equal(serializer.serialize(split), serialize(split));
  const joined = document(before, paragraph("One and two"), after);
  assert.equal(serializer.serialize(joined), serialize(joined));
  assert.deepEqual(calls, [2, 1]);
});

test("structural or unrepresented empty blocks use full serialization before resuming incremental edits", () => {
  const first = paragraph("First");
  const empty = document(first, paragraph(""));
  const calls: number[] = [];
  const serializer = createBodySerializer({
    document: empty,
    source: serialize(empty),
    serialize_fn: (doc) => {
      calls.push(doc.childCount);
      return serialize(doc);
    },
  });
  const next = document(first, paragraph("Second"));
  assert.equal(serializer.serialize(next), serialize(next));
  const quote = document(first, schema.node("blockquote", null, paragraph("Quoted")));
  assert.equal(serializer.serialize(quote), serialize(quote));
  const edited = document(paragraph("First changed"), quote.child(1));
  assert.equal(serializer.serialize(edited), serialize(edited));
  assert.deepEqual(calls, [2, 2, 1]);
});

test("replacing a remote baseline drops the previous document's block ranges", () => {
  const original = document(heading("Old"), paragraph("Old body"));
  const serializer = createBodySerializer({ document: original, source: serialize(original), serialize_fn: serialize });
  const remote = document(paragraph("Remote body"));
  serializer.reset(remote, serialize(remote));
  const edited = document(paragraph("Remote edit"));
  assert.equal(serializer.serialize(edited), serialize(edited));
});
