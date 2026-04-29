import { test } from "node:test";
import assert from "node:assert/strict";
import { ReadinessGate } from "../src/readiness.js";

test("constructor rejects empty subsystem list", () => {
  assert.throws(() => new ReadinessGate([]), /at least one subsystem/);
});

test("initial state is not-ready, all pending", () => {
  const g = new ReadinessGate(["a", "b", "c"]);
  assert.equal(g.isReady(), false);
  assert.deepEqual(g.pending().sort(), ["a", "b", "c"]);
});

test("partial readiness keeps gate closed", () => {
  const g = new ReadinessGate(["a", "b", "c"]);
  g.markReady("a");
  assert.equal(g.isReady(), false);
  assert.deepEqual(g.pending().sort(), ["b", "c"]);
});

test("all subsystems ready opens the gate", () => {
  const g = new ReadinessGate(["a", "b"]);
  g.markReady("a");
  g.markReady("b");
  assert.equal(g.isReady(), true);
  assert.deepEqual(g.pending(), []);
});

test("markReady is idempotent", () => {
  const g = new ReadinessGate(["a"]);
  g.markReady("a");
  g.markReady("a"); // should not throw, should not double-fire listeners
  assert.equal(g.isReady(), true);
});

test("markReady throws on unknown subsystem", () => {
  const g = new ReadinessGate(["a"]);
  assert.throws(() => g.markReady("b"), /unknown subsystem/);
});

test("whenReady resolves immediately when already ready", async () => {
  const g = new ReadinessGate(["a"]);
  g.markReady("a");
  await g.whenReady(); // would hang on bug
});

test("whenReady resolves on transition to ready", async () => {
  const g = new ReadinessGate(["a", "b"]);
  let resolved = false;
  const p = g.whenReady().then(() => { resolved = true; });

  g.markReady("a");
  // Hand control back so any premature resolution would be observed.
  await new Promise(r => setImmediate(r));
  assert.equal(resolved, false, "should not resolve while still pending");

  g.markReady("b");
  await p;
  assert.equal(resolved, true);
});

test("whenReady supports multiple concurrent listeners", async () => {
  const g = new ReadinessGate(["a"]);
  const a = g.whenReady();
  const b = g.whenReady();
  g.markReady("a");
  await Promise.all([a, b]);
});

// Note: the try/catch around listener invocation in markReady() guards
// against non-resolve listeners that throw synchronously. whenReady() only
// registers Promise resolve callbacks (which never throw), so that path
// cannot be exercised through the public API. Left as defensive code.
