import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Queue } from "../src/queue.js";

let dir: string;
let dbPath: string;
let q: Queue;

const refA1 = { host: "github.com", owner: "org", repo: "a", number: 1, headSha: "sha-a-1" };
const refA2 = { host: "github.com", owner: "org", repo: "a", number: 2, headSha: "sha-a-2" };
const refB1 = { host: "github.com", owner: "org", repo: "b", number: 3, headSha: "sha-b-1" };
const refC1 = { host: "github.com", owner: "org", repo: "c", number: 4, headSha: "sha-c-1" };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aegis-queue-"));
  dbPath = join(dir, "test.db");
  q = new Queue(dbPath);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("enqueue + claim returns the same job, FIFO by enqueue time", () => {
  const j1 = q.enqueue(refA1);
  const j2 = q.enqueue(refB1);
  assert.ok(j1 && j2);

  const c1 = q.claim(3);
  assert.equal(c1?.id, j1.id);
  const c2 = q.claim(3);
  assert.equal(c2?.id, j2.id);
  assert.equal(q.claim(3), null);
});

test("enqueue is deduped on (ref, headSha)", () => {
  const first = q.enqueue(refA1);
  const second = q.enqueue(refA1);
  assert.ok(first);
  assert.equal(second, null, "second enqueue with same headSha should be deduped");
});

test("claim with excludeRepoFqns skips matching repos", () => {
  q.enqueue(refA1);
  q.enqueue(refA2);
  q.enqueue(refB1);
  q.enqueue(refC1);

  const first = q.claim(3, []);
  assert.equal(first?.ref.repo, "a", "first claim with no exclusions returns oldest");

  const inflight = ["github.com/org/a"];
  const second = q.claim(3, inflight);
  assert.equal(second?.ref.repo, "b", "second claim should skip repo a");

  const third = q.claim(3, [...inflight, "github.com/org/b"]);
  assert.equal(third?.ref.repo, "c", "third claim should skip a and b");

  const fourth = q.claim(3, [...inflight, "github.com/org/b", "github.com/org/c"]);
  assert.equal(fourth, null, "no claimable jobs when all repos excluded");
});

test("claim with empty excludeRepoFqns behaves like no exclusion", () => {
  q.enqueue(refA1);
  const claimed = q.claim(3, []);
  assert.ok(claimed);
});

test("claim respects maxAttempts limit", () => {
  const job = q.enqueue(refA1);
  assert.ok(job);

  // Exceed retry budget by repeated fail()
  q.claim(3); // attempts -> 1
  q.fail(job.id, "transient", 3); // requeue, attempts stays at 1 in DB after fail (logic-dependent)

  // We just verify the contract: with maxAttempts=1 and an already-attempted job, claim returns null
  // Because attempts >= maxAttempts after the first claim.
  const blocked = q.claim(1);
  assert.equal(blocked, null, "claim should not return jobs beyond maxAttempts");
});

test("complete marks the job done, claim no longer returns it", () => {
  const job = q.enqueue(refA1);
  assert.ok(job);
  const claimed = q.claim(3);
  assert.equal(claimed?.id, job.id);
  q.complete(job.id);
  assert.equal(q.claim(3), null);
});

test("delayRetry sets not_before; claim respects it", async () => {
  const job = q.enqueue(refA1);
  assert.ok(job);
  q.claim(3);
  const outcome = q.delayRetry(job.id, 60); // 60-second delay
  assert.equal(outcome, "deferred");

  const blocked = q.claim(3);
  assert.equal(blocked, null, "deferred job should not be claimable while not_before is in the future");
});

test("delayRetry DLQs after MAX_DEFERS consecutive defers", () => {
  const job = q.enqueue(refA1);
  assert.ok(job);

  // First MAX_DEFERS-1 defers should return "deferred"
  for (let i = 0; i < Queue.MAX_DEFERS - 1; i++) {
    q.claim(3);
    const outcome = q.delayRetry(job.id, 0);
    assert.equal(outcome, "deferred", `defer ${i + 1} should be deferred`);
  }

  // Final defer should DLQ
  q.claim(3);
  const final = q.delayRetry(job.id, 0);
  assert.equal(final, "dlq", "final defer should DLQ");

  const dlq = q.listDlq(10);
  assert.equal(dlq.length, 1);
  assert.equal(dlq[0]?.id, job.id);
});

test("recoverOrphaned resets running jobs to pending", () => {
  const j1 = q.enqueue(refA1);
  q.claim(3); // mark running

  const recovered = q.recoverOrphaned();
  assert.equal(recovered, 1);

  const reclaimed = q.claim(3);
  assert.equal(reclaimed?.id, j1?.id);
});

test("fail() resets defers so a transient error breaks the rate-limit streak", () => {
  // Regression for review finding 5: defers must reset when a non-rate-limit
  // failure happens. A job rate-limited 5 times then failing transiently
  // should not DLQ in 5 more defers - it should get the full MAX_DEFERS budget.
  const job = q.enqueue(refA1);
  assert.ok(job);

  // Rate-limit 5 times.
  for (let i = 0; i < 5; i++) {
    q.claim(10);
    const outcome = q.delayRetry(job.id, -60);
    assert.equal(outcome, "deferred");
  }

  // Transient (non-rate-limit) failure - should reset defers.
  q.claim(10);
  const failOutcome = q.fail(job.id, "boom", 100);
  assert.equal(failOutcome, "retry");

  // Now MAX_DEFERS-1 more defers should still be possible.
  for (let i = 0; i < Queue.MAX_DEFERS - 1; i++) {
    q.claim(100);
    const outcome = q.delayRetry(job.id, -60);
    assert.equal(outcome, "deferred", `post-reset defer ${i + 1} should still be deferred`);
  }

  // The MAX_DEFERS-th defer should now DLQ.
  q.claim(100);
  assert.equal(q.delayRetry(job.id, -60), "dlq");
});

test("claim is atomic - status flips and attempts increments together", () => {
  // Regression for review finding 1: claim() used to be a SELECT then a
  // separate UPDATE. With UPDATE...WHERE id=(SELECT...) RETURNING * the
  // status flip and attempts++ are observed together.
  const j = q.enqueue(refA1);
  assert.ok(j);
  const claimed = q.claim(3);
  assert.ok(claimed);
  assert.equal(claimed.id, j.id);
  assert.equal(claimed.attempts, 1, "attempts incremented atomically with status flip");

  // Re-claim same job: should not be re-claimable until pending again.
  assert.equal(q.claim(3), null, "running job not claimable");
});
