import { required } from "./fixtures.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { NodeType, Schema } from "@milkdown/prose/model";
import { imageAttributes, imageHtml, parseImageHtml } from "../src/image-syntax.ts";
import { bodyFingerprint, extractOutline, parseBody, unsupportedBody } from "../src/markdown.ts";
import { tableFormat } from "../src/table-formats.ts";
test("image HTML retains sizes, layout, literal attributes and Markdown round-trip proof", () => {
  const attributes = {
    src: "../images/a b.png",
    alt: 'A & "quoted" <label>\nNext',
    title: "A title",
    width: "50%",
    height: "240px",
    layout: "center",
  };
  const source = imageHtml(attributes);
  assert.deepEqual(parseImageHtml(source), { ...attributes, ...imageAttributes(attributes) });
  const tree = parseBody(source);
  assert.equal(tree.children[0].type, "imageBlock");
  assert.equal(tree.children[0].width, "50%");
  assert.equal(tree.children[0].layout, "center");
  assert.equal(
    bodyFingerprint(parseBody('<img src="plot.png" alt="Plot">')),
    bodyFingerprint(parseBody("![Plot](plot.png)")),
  );
  assert.notEqual(bodyFingerprint(tree), bodyFingerprint(parseBody("![Plot](plot.png)")));
  assert.equal(extractOutline('# <img src="plot.png" alt="A figure" style="width:50%">')[0].id, "a-figure");
});
test("unsupported HTML attributes and styles are not converted into editable images", () => {
  for (const source of [
    '<img src="x" onerror="alert(1)">',
    '<img src="x" src="other">',
    '<img src="x" style="width:50%;position:fixed">',
    '<img src="x" style="width:expression(alert(1))">',
    '<img src="x" style="background:url(https://example.com)">',
    '<img src="x" width="320" style="width:50%">',
    '<img src="x" style="display:block">',
    '<img src="x" style="width:101%">',
  ]) {
    assert.equal(parseImageHtml(source), null, source);
    assert.equal(parseBody(source).children[0].type, "html", source);
  }
  assert.throws(() => imageAttributes({ width: "0", layout: "inline" }), RangeError);
  assert.throws(() => imageAttributes({ width: "20000", layout: "inline" }), RangeError);
  const mixed = '<img src="x"><script>bad</script>';
  assert.equal(parseImageHtml(mixed), null);
  const retained = JSON.stringify(parseBody(mixed));
  assert.match(retained, /"type":"html","value":"<script>"/);
});
test("sized images keep adjacent Markdown, other images and literal image code intact", () => {
  const html = imageHtml({ src: "first.png", alt: "First", width: "50%" });
  for (const ending of ["\n", "\r\n"]) {
    const tail = ' and **bold** ![Second](second.png) `<img src="literal.png">`';
    const source = html + tail + ending;
    const expected = parseBody("![First](first.png)" + tail + ending);
    assert.equal(expected.children[0].type, "paragraph");
    assert.equal(expected.children[0].children[0].type, "image");
    expected.children[0].children[0].width = "50%";
    assert.equal(bodyFingerprint(parseBody(source)), bodyFingerprint(expected));
    const parsed = parseBody(source);
    assert.equal(parsed.children[0].type, "paragraph");
    const literal = required(parsed.children[0].children.at(-1));
    assert.equal(literal.type, "inlineCode");
    assert.equal(literal.value, '<img src="literal.png">');
    assert.equal(required(parsed.children[0].children[1].position).start.offset, html.length);
  }
});
test("block image parsing separates visual blocks and does not manufacture empty list paragraphs", () => {
  const block = imageHtml({ src: "block.png", alt: "Block", layout: "center", width: "50%" });
  const mixed = parseBody(`Before${block}After\n\n![Inline](inline.png)\n`);
  assert.deepEqual(
    mixed.children.map((node) => node.type),
    ["paragraph", "imageBlock", "paragraph", "imageBlock"],
  );
  assert.equal(mixed.children[0].type, "paragraph");
  assert.equal(mixed.children[0].children[0].type, "text");
  assert.equal(mixed.children[0].children[0].value, "Before");
  assert.equal(required(mixed.children[1].position).start.offset, "Before".length);
  assert.equal(mixed.children[2].type, "paragraph");
  assert.equal(mixed.children[2].children[0].type, "text");
  assert.equal(mixed.children[2].children[0].value, "After");
  assert.equal(mixed.children[3].type, "imageBlock");
  const list = parseBody(`- ${block}\n`);
  assert.equal(list.children[0].type, "list");
  const item = list.children[0].children[0];
  assert.deepEqual(
    item.children.map((node) => node.type),
    ["imageBlock"],
  );
  assert.equal(bodyFingerprint(parseBody(block)), bodyFingerprint(parseBody(`${block}\n`)));
});
test("standalone Markdown and reference images become blocks while explicit Inline persists without changing text images", () => {
  const markdown = "![Figure](figure.png)\n";
  assert.equal(parseBody(markdown).children[0].type, "imageBlock");
  const reference = "![Figure][figure]\n\n[figure]: figure.png\n";
  const tree = parseBody(reference);
  assert.equal(tree.children[0].type, "imageBlock");
  assert.equal(bodyFingerprint(tree), bodyFingerprint(parseBody(markdown)));
  assert.equal(unsupportedBody(tree, reference), "");
  const inline = imageHtml({ src: "figure.png", alt: "Figure", layout: "inline", explicitInline: true });
  assert.match(inline, /style="display:inline"/);
  assert.equal(required(parseImageHtml(inline)).explicitInline, true);
  assert.equal(parseBody(inline).children[0].type, "paragraph");
  assert.equal(parseBody("Before ![Figure](figure.png) after").children[0].type, "paragraph");
  assert.equal(parseBody("![First](a.png)\n![Second](b.png)").children.length, 2);
  const row = parseBody("![First](a.png) ![Second](b.png)");
  assert.equal(row.children[0].type, "paragraph");
  assert.equal(row.children[0].children.filter((node) => node.type === "image").length, 2);
  const adjacent = parseBody('<img src="first.png"><img src="second.png">');
  assert.equal(adjacent.children[0].type, "paragraph");
  assert.deepEqual(
    adjacent.children[0].children.map((node) => {
      assert.equal(node.type, "image");
      return [node.type, node.url];
    }),
    [
      ["image", "first.png"],
      ["image", "second.png"],
    ],
  );
  assert.equal(parseImageHtml('<img src="a.png" style="display:inline;margin-left:auto">'), null);
});
const schema = new Schema({
  nodes: {
    doc: { content: "table" },
    table: { content: "table_row+" },
    table_row: { content: "(table_cell | table_header)+" },
    table_cell: { content: "paragraph", attrs: { alignment: { default: "left" } } },
    table_header: { content: "paragraph", attrs: { alignment: { default: "left" } } },
    paragraph: { content: "(text | hardbreak)*" },
    hardbreak: { inline: true, group: "inline" },
    text: {},
  },
});
const cell = (type: string | NodeType, text: string) =>
  schema.node(
    type,
    null,
    schema.node(
      "paragraph",
      null,
      text
        .split("\n")
        .flatMap((line, index) => [...(index ? [schema.node("hardbreak")] : []), ...(line ? [schema.text(line)] : [])]),
    ),
  );
const table = schema.node("table", null, [
  schema.node(
    "table_row",
    null,
    ["Name", "Value", "Notes"].map((value) => cell("table_header", value)),
  ),
  schema.node(
    "table_row",
    null,
    ["A\tB", 'One, "two"', "<script>literal</script>\nNext"].map((value) => cell("table_cell", value)),
  ),
]);
test("table exports preserve delimiters, multiline cells and literal HTML without executing markup", () => {
  const format = (name: string): string =>
    tableFormat({ table, format: name, markdown_fn: () => "| Name | Value | Notes |\n" });
  assert.equal(format("csv"), 'Name,Value,Notes\r\nA\tB,"One, ""two""","<script>literal</script>\nNext"\r\n');
  assert.equal(format("tsv"), 'Name\tValue\tNotes\n"A\tB"\t"One, ""two"""\t"<script>literal</script>\nNext"\n');
  assert.deepEqual(JSON.parse(format("json")), [
    ["Name", "Value", "Notes"],
    ["A\tB", 'One, "two"', "<script>literal</script>\nNext"],
  ]);
  assert.match(format("html"), /<th style="text-align:left">Name<\/th>/);
  assert.match(format("html"), /&lt;script&gt;literal&lt;\/script&gt;<br>Next/);
  assert.doesNotMatch(format("html"), /<script>/);
  assert.equal(format("markdown"), "| Name | Value | Notes |\n");
});
