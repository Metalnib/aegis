import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { GitLabAdapter } from "../../src/adapter.js";
import type { AdapterContext, KvStore, Logger, SecretsProvider, BusEvent, PrEvent } from "@aegis/sdk";

const TOKEN = "test-token";
const SECRET = "supersecret-gitlab-token";

class FakeKvStore implements KvStore {
  private readonly map = new Map<string, string>();
  async get(key: string): Promise<string | undefined> { return this.map.get(key); }
  async set(key: string, value: string): Promise<void> { this.map.set(key, value); }
  async delete(key: string): Promise<void> { this.map.delete(key); }
  async list(prefix: string): Promise<string[]> { return [...this.map.keys()].filter(k => k.startsWith(prefix)); }
}

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

class FakeSecrets implements SecretsProvider {
  constructor(private readonly map: Record<string, string>) {}
  get(name: string): string {
    const v = this.map[name];
    if (v == null) throw new Error(`secret ${name} not set`);
    return v;
  }
}

function makeCtx(): AdapterContext {
  return {
    logger: silentLogger,
    secrets: new FakeSecrets({ GITLAB_TOKEN: TOKEN, GITLAB_WEBHOOK_SECRET: SECRET }),
    store: new FakeKvStore(),
    clock: () => new Date(),
    config: {},
    emit: (_e: BusEvent) => {},
  };
}

function buildMrPayload(action: string, group: string, repo: string, iid: number, sha: string): string {
  return JSON.stringify({
    object_attributes: { iid, action, last_commit: { id: sha } },
    project: { path: repo, namespace: group },
  });
}

let adapter: GitLabAdapter;

beforeEach(async () => {
  adapter = new GitLabAdapter({
    group: "mygroup",
    repos: ["svc-a", "svc-b"],
    tokenEnv: "GITLAB_TOKEN",
    webhookSecretEnv: "GITLAB_WEBHOOK_SECRET",
  });
  await adapter.init(makeCtx());
});

test("webhook accepts payload with valid token and emits PrEvent", async () => {
  const events: PrEvent[] = [];
  adapter.subscribe?.(e => events.push(e));

  const body = buildMrPayload("open", "mygroup", "svc-a", 7, "deadbeef");
  const res = await adapter.webhook!.handle({
    method: "POST",
    headers: {
      "x-gitlab-event": "Merge Request Hook",
      "x-gitlab-token": SECRET,
    },
    body: Buffer.from(body),
  });

  assert.equal(res.status, 200);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "opened");
  assert.equal(events[0]?.ref.repo, "svc-a");
  assert.equal(events[0]?.ref.number, 7);
  assert.equal(events[0]?.ref.headSha, "deadbeef");
});

test("webhook rejects payload with wrong token", async () => {
  const events: PrEvent[] = [];
  adapter.subscribe?.(e => events.push(e));

  const body = buildMrPayload("open", "mygroup", "svc-a", 7, "deadbeef");
  const res = await adapter.webhook!.handle({
    method: "POST",
    headers: {
      "x-gitlab-event": "Merge Request Hook",
      "x-gitlab-token": "wrong-token",
    },
    body: Buffer.from(body),
  });

  assert.equal(res.status, 401);
  assert.equal(events.length, 0);
});

test("webhook rejects payload with no token header", async () => {
  const body = buildMrPayload("open", "mygroup", "svc-a", 7, "deadbeef");
  const res = await adapter.webhook!.handle({
    method: "POST",
    headers: { "x-gitlab-event": "Merge Request Hook" },
    body: Buffer.from(body),
  });

  assert.equal(res.status, 401);
});

test("non-MR event types are ignored with 200", async () => {
  const events: PrEvent[] = [];
  adapter.subscribe?.(e => events.push(e));

  const body = buildMrPayload("open", "mygroup", "svc-a", 7, "deadbeef");
  const res = await adapter.webhook!.handle({
    method: "POST",
    headers: {
      "x-gitlab-event": "Push Hook",
      "x-gitlab-token": SECRET,
    },
    body: Buffer.from(body),
  });

  assert.equal(res.status, 200);
  assert.match(res.body ?? "", /ignored/);
  assert.equal(events.length, 0);
});

test("MR action 'reopen' produces a reopened event", async () => {
  const events: PrEvent[] = [];
  adapter.subscribe?.(e => events.push(e));

  const body = buildMrPayload("reopen", "mygroup", "svc-a", 7, "deadbeef");
  await adapter.webhook!.handle({
    method: "POST",
    headers: { "x-gitlab-event": "Merge Request Hook", "x-gitlab-token": SECRET },
    body: Buffer.from(body),
  });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "reopened");
});

test("payload for wrong namespace is dropped", async () => {
  const events: PrEvent[] = [];
  adapter.subscribe?.(e => events.push(e));

  const body = buildMrPayload("open", "different-group", "svc-a", 7, "deadbeef");
  const res = await adapter.webhook!.handle({
    method: "POST",
    headers: { "x-gitlab-event": "Merge Request Hook", "x-gitlab-token": SECRET },
    body: Buffer.from(body),
  });

  assert.equal(res.status, 200);
  assert.match(res.body ?? "", /wrong namespace/);
  assert.equal(events.length, 0);
});

test("payload for an untracked repo is dropped", async () => {
  const events: PrEvent[] = [];
  adapter.subscribe?.(e => events.push(e));

  const body = buildMrPayload("open", "mygroup", "not-tracked", 7, "deadbeef");
  const res = await adapter.webhook!.handle({
    method: "POST",
    headers: { "x-gitlab-event": "Merge Request Hook", "x-gitlab-token": SECRET },
    body: Buffer.from(body),
  });

  assert.equal(res.status, 200);
  assert.match(res.body ?? "", /repo not tracked/);
  assert.equal(events.length, 0);
});

test("malformed JSON returns 400", async () => {
  const res = await adapter.webhook!.handle({
    method: "POST",
    headers: { "x-gitlab-event": "Merge Request Hook", "x-gitlab-token": SECRET },
    body: Buffer.from("{not-json"),
  });

  assert.equal(res.status, 400);
});
