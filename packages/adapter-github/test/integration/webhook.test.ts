import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { GitHubAdapter } from "../../src/adapter.js";
import type { AdapterContext, KvStore, Logger, SecretsProvider, BusEvent, PrEvent } from "@aegis/sdk";

const TOKEN = "test-token";
const SECRET = "supersecret-webhook";

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
    secrets: new FakeSecrets({ GITHUB_TOKEN: TOKEN, GITHUB_WEBHOOK_SECRET: SECRET }),
    store: new FakeKvStore(),
    clock: () => new Date(),
    config: {},
    emit: (_e: BusEvent) => {},
  };
}

function buildPayload(action: string, repo: string, owner: string, prNumber: number, headSha: string): string {
  return JSON.stringify({
    action,
    pull_request: { number: prNumber, head: { sha: headSha } },
    repository: { name: repo, owner: { login: owner } },
  });
}

function sign(secret: string, body: Buffer | string): string {
  const buf = typeof body === "string" ? Buffer.from(body) : body;
  return "sha256=" + crypto.createHmac("sha256", secret).update(buf).digest("hex");
}

let adapter: GitHubAdapter;

beforeEach(async () => {
  adapter = new GitHubAdapter({
    org: "myorg",
    repos: ["svc-a", "svc-b"],
    tokenEnv: "GITHUB_TOKEN",
    webhookSecretEnv: "GITHUB_WEBHOOK_SECRET",
  });
  await adapter.init(makeCtx());
});

test("webhook accepts payload with valid HMAC and emits PrEvent", async () => {
  const events: PrEvent[] = [];
  adapter.subscribe?.(e => events.push(e));

  const body = buildPayload("opened", "svc-a", "myorg", 42, "deadbeef");
  const buf = Buffer.from(body);
  const res = await adapter.webhook!.handle({
    method: "POST",
    headers: {
      "x-github-event": "pull_request",
      "x-hub-signature-256": sign(SECRET, buf),
    },
    body: buf,
  });

  assert.equal(res.status, 200);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "opened");
  assert.equal(events[0]?.ref.repo, "svc-a");
  assert.equal(events[0]?.ref.number, 42);
  assert.equal(events[0]?.ref.headSha, "deadbeef");
});

test("webhook rejects payload with invalid signature", async () => {
  const events: PrEvent[] = [];
  adapter.subscribe?.(e => events.push(e));

  const body = buildPayload("opened", "svc-a", "myorg", 42, "deadbeef");
  const buf = Buffer.from(body);
  const res = await adapter.webhook!.handle({
    method: "POST",
    headers: {
      "x-github-event": "pull_request",
      "x-hub-signature-256": sign("wrong-secret", buf),
    },
    body: buf,
  });

  assert.equal(res.status, 401);
  assert.equal(events.length, 0);
});

test("webhook rejects payload with no signature header", async () => {
  const events: PrEvent[] = [];
  adapter.subscribe?.(e => events.push(e));

  const body = buildPayload("opened", "svc-a", "myorg", 42, "deadbeef");
  const buf = Buffer.from(body);
  const res = await adapter.webhook!.handle({
    method: "POST",
    headers: { "x-github-event": "pull_request" },
    body: buf,
  });

  assert.equal(res.status, 401);
  assert.equal(events.length, 0);
});

test("webhook rejects signature with wrong scheme prefix", async () => {
  const body = buildPayload("opened", "svc-a", "myorg", 42, "deadbeef");
  const buf = Buffer.from(body);
  const validSig = sign(SECRET, buf);
  const wrongScheme = validSig.replace("sha256=", "sha1=");

  const res = await adapter.webhook!.handle({
    method: "POST",
    headers: {
      "x-github-event": "pull_request",
      "x-hub-signature-256": wrongScheme,
    },
    body: buf,
  });

  assert.equal(res.status, 401);
});

test("webhook rejects tampered body even if signature is from valid secret", async () => {
  const original = buildPayload("opened", "svc-a", "myorg", 42, "deadbeef");
  const sig = sign(SECRET, Buffer.from(original));

  // Tamper with the body after signing.
  const tampered = original.replace('"deadbeef"', '"cafef00d"');

  const res = await adapter.webhook!.handle({
    method: "POST",
    headers: {
      "x-github-event": "pull_request",
      "x-hub-signature-256": sig,
    },
    body: Buffer.from(tampered),
  });

  assert.equal(res.status, 401, "signature tied to original body must reject tampered body");
});

test("ping events are accepted with 200 pong without emitting", async () => {
  const events: PrEvent[] = [];
  adapter.subscribe?.(e => events.push(e));

  const buf = Buffer.from('{"zen":"hello"}');
  const res = await adapter.webhook!.handle({
    method: "POST",
    headers: {
      "x-github-event": "ping",
      "x-hub-signature-256": sign(SECRET, buf),
    },
    body: buf,
  });

  assert.equal(res.status, 200);
  assert.equal(res.body, "pong");
  assert.equal(events.length, 0);
});

test("payload for an untracked repo is dropped", async () => {
  const events: PrEvent[] = [];
  adapter.subscribe?.(e => events.push(e));

  const body = buildPayload("opened", "not-a-tracked-repo", "myorg", 1, "abc");
  const buf = Buffer.from(body);
  const res = await adapter.webhook!.handle({
    method: "POST",
    headers: {
      "x-github-event": "pull_request",
      "x-hub-signature-256": sign(SECRET, buf),
    },
    body: buf,
  });

  assert.equal(res.status, 200, "200 with body 'repo not tracked' so GitHub does not retry");
  assert.match(res.body ?? "", /repo not tracked/);
  assert.equal(events.length, 0);
});

test("payload for wrong org is dropped", async () => {
  const events: PrEvent[] = [];
  adapter.subscribe?.(e => events.push(e));

  const body = buildPayload("opened", "svc-a", "differentorg", 1, "abc");
  const buf = Buffer.from(body);
  const res = await adapter.webhook!.handle({
    method: "POST",
    headers: {
      "x-github-event": "pull_request",
      "x-hub-signature-256": sign(SECRET, buf),
    },
    body: buf,
  });

  assert.equal(res.status, 200);
  assert.match(res.body ?? "", /wrong org/);
  assert.equal(events.length, 0);
});

test("ignored actions are silently dropped", async () => {
  const events: PrEvent[] = [];
  adapter.subscribe?.(e => events.push(e));

  // GitHub fires "labeled", "edited", etc. that we do not act on.
  const body = buildPayload("labeled", "svc-a", "myorg", 42, "deadbeef");
  const buf = Buffer.from(body);
  const res = await adapter.webhook!.handle({
    method: "POST",
    headers: {
      "x-github-event": "pull_request",
      "x-hub-signature-256": sign(SECRET, buf),
    },
    body: buf,
  });

  assert.equal(res.status, 200);
  assert.match(res.body ?? "", /ignored/);
  assert.equal(events.length, 0);
});

test("malformed JSON returns 400", async () => {
  const buf = Buffer.from("not-json{");
  const res = await adapter.webhook!.handle({
    method: "POST",
    headers: {
      "x-github-event": "pull_request",
      "x-hub-signature-256": sign(SECRET, buf),
    },
    body: buf,
  });

  assert.equal(res.status, 400);
});
