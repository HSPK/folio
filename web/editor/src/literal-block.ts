import { Fragment, type Node as ProseNode } from "@milkdown/prose/model";
import { $nodeSchema } from "@milkdown/utils";
import type { Root } from "mdast";
import { serializedBodyTree } from "./body-serialization.ts";
import { bodyFingerprint, extractOutline } from "./markdown.ts";
import { normalizeSerializedBody } from "./roundtrip.ts";

// Only the proof below can create this atom from Markdown. Never interpret the
// stored text as DOM, including on paste: HTML from the clipboard isn't proof.
export const literalBlock = $nodeSchema("literal_block", () => ({
  group: "block",
  atom: true,
  isolating: true,
  attrs: { source: { validate: "string" }, level: { default: 0 }, label: { default: "" } },
  toDOM: (node) => [
    node.attrs.level >= 1 && node.attrs.level <= 6 ? `h${node.attrs.level}` : "pre",
    { class: "folio-literal-block", title: "Preserved Markdown — edit this block in Source mode" },
    node.attrs.source,
  ],
  leafText: (node) => node.attrs.source,
  parseMarkdown: { match: () => false, runner: () => {} },
  toMarkdown: {
    match: (node) => node.type.name === "literal_block",
    // Remark's verbatim serializer (not an HTML renderer).
    runner: (state, node) => state.addNode("html", undefined, node.attrs.source),
  },
}));

export function proveLiveBody(document: ProseNode, source: string, tree: Root, serialize: (doc: ProseNode) => string) {
  const proof = (doc: ProseNode) => {
    const serialized = normalizeSerializedBody(serialize(doc), doc);
    const serializedTree = serializedBodyTree({ source, tree, serialized });
    return { document: doc, serialized, serializedTree };
  };
  const initial = proof(document);
  if (initial.serializedTree === tree) return initial;
  const original = bodyFingerprint(tree);
  if (original === bodyFingerprint(initial.serializedTree)) return initial;

  // Only repair aligned top-level prose blocks. Definitions and other global
  // constructs, or a serializer that has merged/dropped blocks, fail closed.
  if (document.childCount !== tree.children.length || document.childCount !== initial.serializedTree.children.length)
    return null;
  const blocks: ProseNode[] = [];
  let repaired = false;
  const fingerprint = (child: Root["children"][number]) => bodyFingerprint({ type: "root", children: [child] });
  for (const [index, block] of tree.children.entries()) {
    const model = document.child(index);
    const output = initial.serializedTree.children[index];
    if (fingerprint(block) === fingerprint(output)) {
      blocks.push(model);
      continue;
    }
    const from = block.position?.start.offset;
    const to = block.position?.end.offset;
    if (
      !["paragraph", "table", "list", "heading"].includes(block.type) ||
      (block.type === "list" ? (block.ordered ? "ordered_list" : "bullet_list") : block.type) !== model.type.name ||
      block.type !== output.type ||
      block.position?.start.column !== 1 ||
      from === undefined ||
      to === undefined
    )
      return null;
    const raw = source.slice(from, to);
    const heading = block.type === "heading" ? extractOutline(raw)[0] : null;
    blocks.push(
      document.type.schema.nodes.literal_block.create({ source: raw, level: heading?.level, label: heading?.text }),
    );
    repaired = true;
  }
  if (!repaired) return null;
  const result = proof(document.copy(Fragment.fromArray(blocks)));
  return original === bodyFingerprint(result.serializedTree) ? result : null;
}
