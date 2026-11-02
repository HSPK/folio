import test from "node:test";
import assert from "node:assert/strict";

import { remarkDisplayMath } from "../src/math-syntax.ts";
import type { Root } from "mdast";
import { VFile } from "vfile";

test("single-line double-dollar paragraphs become display math", () => {
  const source = "Before\n\n$$x^2 + y^2$$\n";
  const start = source.indexOf("$$");
  const tree: Root = {
    type: "root",
    children: [
      {
        type: "paragraph",
        children: [{ type: "inlineMath", value: "x^2 + y^2" }],
        position: {
          start: { offset: start, line: 3, column: 1 },
          end: { offset: source.length - 1, line: 3, column: 16 },
        },
      },
    ],
  };
  remarkDisplayMath()(tree, new VFile(source));
  assert.equal(tree.children[0].type, "math");
  assert.equal(tree.children[0].value, "x^2 + y^2");
});
