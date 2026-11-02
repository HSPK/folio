import assert from "node:assert/strict";
import { NodeSelection, type Selection } from "@milkdown/prose/state";

export function required<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined);
  return value;
}

export function selectedNode(selection: Selection) {
  assert.ok(selection instanceof NodeSelection);
  return selection.node;
}
