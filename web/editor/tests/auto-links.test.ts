import { required } from "./fixtures.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { Schema, type Mark } from "@milkdown/prose/model";
import { EditorState } from "@milkdown/prose/state";
import { findAutoLinks, autoLinkTransaction } from "../src/auto-links.ts";
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    code_block: { group: "block", content: "text*", code: true },
    math_inline: { group: "inline", inline: true, content: "text*", code: true },
    text: { group: "inline" },
  },
  marks: { link: { attrs: { href: {}, auto: { default: false } }, inclusive: false }, inlineCode: { code: true } },
});
const state = (text = "", type = "paragraph", marks: readonly Mark[] = []) =>
  EditorState.create({
    schema,
    doc: schema.node("doc", null, [schema.node(type, null, text ? [schema.text(text, marks)] : [])]),
  });
test("automatic links recognize the approved forms and trim sentence punctuation", () => {
  const text = "Visit https://example.com/a_(b), www.example.org and person@example.com.";
  assert.deepEqual(
    findAutoLinks(text).map((link) => [text.slice(link.from, link.to), link.href]),
    [
      ["https://example.com/a_(b)", "https://example.com/a_(b)"],
      ["www.example.org", "http://www.example.org"],
      ["person@example.com", "mailto:person@example.com"],
    ],
  );
  assert.deepEqual(findAutoLinks("`https://example.com` and [label](https://example.org)"), []);
  assert.deepEqual(findAutoLinks("ftp://example.com notes/Plan.md javascript:alert(1)"), []);
  const chinese = "访问 https://example.com，继续写作。";
  assert.deepEqual(findAutoLinks(chinese), [{ from: 3, to: 22, href: "https://example.com" }]);
});
test("typing and editing a detected URL updates its mark without changing the displayed text", () => {
  let before = state();
  let after = before.apply(before.tr.insertText("https://example.com"));
  after = after.apply(required(autoLinkTransaction(before, after)));
  assert.equal(after.doc.textContent, "https://example.com");
  assert.equal(after.doc.child(0).child(0).marks[0].attrs.href, "https://example.com");
  before = after;
  after = before.apply(before.tr.insertText("/guide", before.doc.content.size - 1));
  after = after.apply(required(autoLinkTransaction(before, after)));
  assert.equal(after.doc.child(0).child(0).marks[0].attrs.href, "https://example.com/guide");
  assert.equal(autoLinkTransaction(after, after), null);
});
test("code and explicit link destinations are never overwritten by automatic detection", () => {
  for (const before of [
    state("x", "code_block"),
    state("x", "paragraph", [schema.marks.inlineCode.create()]),
    state("x", "paragraph", [schema.marks.link.create({ href: "https://kept.example", auto: false })]),
  ]) {
    const after = before.apply(
      before.tr.replaceWith(1, 2, schema.text("https://example.com", before.doc.child(0).child(0).marks)),
    );
    assert.equal(autoLinkTransaction(before, after) === null, true);
  }
});
test("inline node sizes do not shift links after formulas", () => {
  const math = schema.node("math_inline", null, schema.text("x"));
  const before = EditorState.create({
    schema,
    doc: schema.node("doc", null, schema.node("paragraph", null, [math, schema.text(" ")])),
  });
  let after = before.apply(before.tr.insertText("https://example.com", before.doc.content.size - 1));
  after = after.apply(required(autoLinkTransaction(before, after)));
  const links: {
    position: number;
    text: string | undefined;
  }[] = [];
  after.doc.descendants((node, position) => {
    if (node.marks.some((mark) => mark.type.name === "link")) links.push({ position, text: node.text });
  });
  assert.deepEqual(links, [{ position: 5, text: "https://example.com" }]);
  assert.equal(after.doc.child(0).child(0).eq(math), true);
});
