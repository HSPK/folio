import test from "node:test";
import assert from "node:assert/strict";
import { Lifetime } from "../../shared/lifetime.ts";

test("lifetimes release resources in reverse order exactly once and detach their listeners", () => {
  const lifetime = new Lifetime();
  const events = new EventTarget();
  const released: number[] = [];
  let calls = 0;
  lifetime.listen(events, "change", () => {
    calls++;
  });
  lifetime.defer(() => released.push(1));
  lifetime.defer(() => released.push(2));
  events.dispatchEvent(new Event("change"));
  lifetime.dispose();
  lifetime.dispose();
  events.dispatchEvent(new Event("change"));
  assert.equal(calls, 1);
  assert.deepEqual(released, [2, 1]);
  assert.equal(lifetime.signal.aborted, true);
});

test("failed resource cleanup cannot prevent remaining cleanup and late ownership releases immediately", () => {
  const lifetime = new Lifetime();
  let released = 0;
  lifetime.defer(() => {
    released++;
  });
  lifetime.defer(() => {
    throw new Error("Cleanup failure");
  });
  assert.throws(() => lifetime.dispose(), AggregateError);
  lifetime.defer(() => {
    released++;
  });
  assert.equal(released, 2);
  assert.throws(() => lifetime.listen(new EventTarget(), "change", () => {}), { name: "AbortError" });
});
