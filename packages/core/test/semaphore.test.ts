import { test } from "node:test";
import assert from "node:assert/strict";
import { Semaphore } from "../src/semaphore.js";

test("constructor rejects zero or negative permits", () => {
  assert.throws(() => new Semaphore(0), /at least 1 permit/);
  assert.throws(() => new Semaphore(-1), /at least 1 permit/);
});

test("acquire returns immediately when permits available", async () => {
  const s = new Semaphore(2);
  assert.equal(s.available(), 2);
  const r1 = await s.acquire();
  assert.equal(s.available(), 1);
  const r2 = await s.acquire();
  assert.equal(s.available(), 0);
  r1(); r2();
  assert.equal(s.available(), 2);
});

test("acquire queues when permits exhausted, FIFO order", async () => {
  const s = new Semaphore(1);
  const order: string[] = [];

  const r1 = await s.acquire();
  order.push("first-acquired");

  const second = s.acquire().then(r => { order.push("second"); return r; });
  const third = s.acquire().then(r => { order.push("third"); return r; });

  // Yield, confirm neither has fired.
  await new Promise(r => setImmediate(r));
  assert.deepEqual(order, ["first-acquired"]);

  r1();
  const r2 = await second;
  assert.deepEqual(order, ["first-acquired", "second"]);
  r2();
  const r3 = await third;
  assert.deepEqual(order, ["first-acquired", "second", "third"]);
  r3();
});

test("releaser is one-shot - double release does not leak permits", async () => {
  const s = new Semaphore(1);
  const release = await s.acquire();
  assert.equal(s.available(), 0);

  release();
  assert.equal(s.available(), 1);
  release(); // second call should be a no-op
  assert.equal(s.available(), 1, "second release must not over-credit permits");
});

test("permits are not lost when many concurrent acquirers compete", async () => {
  const s = new Semaphore(3);
  const releasers: Array<() => void> = [];

  // Acquire all 3 permits.
  for (let i = 0; i < 3; i++) releasers.push(await s.acquire());
  assert.equal(s.available(), 0);

  // 5 more acquirers queue up.
  const queued = Array.from({ length: 5 }, () => s.acquire());

  // Release in a non-FIFO order: r1, r3, r2.
  releasers[0]!();
  releasers[2]!();
  releasers[1]!();

  // Three of the five queued should now have permits.
  const firstThreeReleasers = await Promise.all([queued[0]!, queued[1]!, queued[2]!]);
  assert.equal(s.available(), 0);

  // Release them and the last two should resolve.
  for (const r of firstThreeReleasers) r();
  const lastTwo = await Promise.all([queued[3]!, queued[4]!]);
  assert.equal(s.available(), 1, "should have 1 permit after 3 holders + 2 inflight resolve");

  for (const r of lastTwo) r();
  assert.equal(s.available(), 3, "all permits returned");
});
