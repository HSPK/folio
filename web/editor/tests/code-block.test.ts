import { required } from "./fixtures.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { Node, Schema } from "@milkdown/prose/model";
import { codeBlockDecorations } from "../src/code-block.ts";
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*" },
    code_block: { group: "block", content: "text*", marks: "", attrs: { language: { default: "" } } },
    text: {},
  },
});
const document = (language: string, text: string) =>
  schema.node("doc", null, [
    schema.node("paragraph", null, schema.text("Before")),
    schema.node("code_block", { language }, text ? schema.text(text) : []),
    schema.node("paragraph", null, schema.text("After")),
  ]);
const tokens = (doc: Node) =>
  codeBlockDecorations(doc).map((decoration) => {
    assert.ok("type" in decoration && typeof decoration.type === "object" && decoration.type !== null);
    assert.ok(
      "attrs" in decoration.type && typeof decoration.type.attrs === "object" && decoration.type.attrs !== null,
    );
    assert.ok("class" in decoration.type.attrs && typeof decoration.type.attrs.class === "string");
    return {
      text: doc.textBetween(decoration.from, decoration.to),
      classes: decoration.type.attrs.class.split(" "),
      from: decoration.from,
    };
  });
test("centralized code highlighting preserves aliases, dialects and document offsets", () => {
  for (const [language, text, keyword] of [
    ["RS", "fn main() { let value = 42; }", "fn"],
    ["c++", "int main() { return 42; }", "return"],
    ["cjs", "const value = 42;", "const"],
    ["ts", "const value: number = 42;", "const"],
    ["tsx", "const View = () => <div>{42}</div>;", "const"],
  ]) {
    const doc = document(language, text);
    const highlighted = tokens(doc);
    assert.ok(highlighted.some((token) => token.text === keyword && token.classes.includes("folio-code-keyword")));
    assert.ok(highlighted.some((token) => token.text === "42" && token.classes.includes("folio-code-number")));
    assert.ok(highlighted.every((token) => token.from >= doc.child(0).nodeSize + 1));
    assert.equal(doc.child(1).textContent, text);
    assert.equal(doc.child(0).textContent, "Before");
    assert.equal(required(doc.lastChild).textContent, "After");
  }
});
test("plain, empty and unknown code remains literal without language-dependent decorations", () => {
  for (const [language, text] of [
    ["", "literal <b> text"],
    ["text", "https://example.com"],
    ["custom.dsl", "custom syntax"],
    ["constructor", "literal"],
    ["rust", ""],
  ]) {
    const doc = document(language, text);
    assert.deepEqual(codeBlockDecorations(doc), []);
    assert.equal(doc.child(1).textContent, text);
  }
});
