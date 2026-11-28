import test from "node:test";
import assert from "node:assert/strict";
import { mapImageRange } from "../src/image-bookmarks.ts";
import { createSharedText } from "../src/shared-text.ts";

test("pending image replacements exclude later typing at either endpoint and invalidate on destructive edits", () => {
  const range = { from: 3, to: 6 };
  assert.deepEqual(
    mapImageRange(range, [
      { fromA: 3, toA: 3, fromB: 3, toB: 5 },
      { fromA: 6, toA: 6, fromB: 8, toB: 10 },
    ]),
    { from: 5, to: 8 },
  );
  assert.equal(mapImageRange(range, [{ fromA: 4, toA: 4, fromB: 4, toB: 7 }]), null);
  assert.equal(mapImageRange({ from: 5, to: 5 }, [{ fromA: 4, toA: 6, fromB: 4, toB: 4 }]), null);
  const point = { from: 3, to: 3 };
  const insert = [{ fromA: 3, toA: 3, fromB: 3, toB: 11 }];
  assert.deepEqual(mapImageRange(point, insert), point);
  assert.deepEqual(mapImageRange(point, insert, true), { from: 11, to: 11 });
});

test("a shared image bookmark maps through disjoint remote edits, but never through deletion of its target", () => {
  const writer = createSharedText(() => {});
  const reader = createSharedText(() => {});
  try {
    writer.replace("Left|middle|Right");
    reader.apply(writer.snapshot());
    let range: { from: number; to: number } | null = { from: 5, to: 11 };
    const stop = reader.watchRemoteImageEdits((changes, text) => {
      assert.equal(text, reader.value);
      if (range) range = mapImageRange(range, changes);
    });
    writer.replace("Before Left|middle|Right after");
    reader.apply(writer.snapshot());
    assert.deepEqual(range, { from: 12, to: 18 });
    writer.replace("Before Left|discarded|Right after");
    reader.apply(writer.snapshot());
    assert.equal(range, null);
    stop();
  } finally {
    reader.destroy();
    writer.destroy();
  }
});
