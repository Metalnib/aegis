import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { HttpServer } from "../../src/http-server.js";
import { ReadinessGate } from "../../src/readiness.js";
import type { WebhookEndpoint } from "@aegis/sdk";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

let server: HttpServer | null = null;
let port = 0;
let portCounter = 18180;

beforeEach(() => {
  // Different port per test - avoids the previous test's lingering TIME_WAIT socket.
  port = portCounter++;
});

afterEach(async () => {
  if (server) {
    await server.stop();
    server = null;
  }
});

interface FetchResult { status: number; body: string; contentType: string }

async function get(path: string, headers: Record<string, string> = {}): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => { body += c.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, contentType: res.headers["content-type"] ?? "" }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function post(path: string, body: string, headers: Record<string, string> = {}): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-length": String(Buffer.byteLength(body)), ...headers } }, (res) => {
      let respBody = "";
      res.on("data", (c: Buffer) => { respBody += c.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: respBody, contentType: res.headers["content-type"] ?? "" }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

test("/healthz returns 200 ok when no readiness gate is configured", async () => {
  server = new HttpServer({ port, logger: silent, webhooks: new Map() });
  await server.start();

  const r = await get("/healthz");
  assert.equal(r.status, 200);
  assert.equal(r.body, "ok");
});

test("/healthz returns 503 with pending list while gate is closed", async () => {
  const gate = new ReadinessGate(["sqlite", "synopsis", "mcp"]);
  server = new HttpServer({ port, logger: silent, webhooks: new Map(), readinessGate: gate });
  await server.start();

  const r = await get("/healthz");
  assert.equal(r.status, 503);
  assert.match(r.contentType, /application\/json/);
  const parsed = JSON.parse(r.body);
  assert.equal(parsed.status, "not-ready");
  assert.deepEqual(parsed.pending.sort(), ["mcp", "sqlite", "synopsis"]);
});

test("/healthz transitions to 200 once all subsystems are ready", async () => {
  const gate = new ReadinessGate(["sqlite", "mcp"]);
  server = new HttpServer({ port, logger: silent, webhooks: new Map(), readinessGate: gate });
  await server.start();

  let r = await get("/healthz");
  assert.equal(r.status, 503);

  gate.markReady("sqlite");
  gate.markReady("mcp");

  r = await get("/healthz");
  assert.equal(r.status, 200);
  assert.equal(r.body, "ok");
});

test("webhook returns 503 starting while not-ready", async () => {
  const gate = new ReadinessGate(["sqlite"]);
  let webhookCalled = false;
  const endpoint: WebhookEndpoint = {
    path: "/webhooks/test",
    handle: async () => { webhookCalled = true; return { status: 200, body: "queued" }; },
  };

  server = new HttpServer({ port, logger: silent, webhooks: new Map([["/webhooks/test", endpoint]]), readinessGate: gate });
  await server.start();

  const r = await post("/webhooks/test", "{}", { "content-type": "application/json" });
  assert.equal(r.status, 503);
  const parsed = JSON.parse(r.body);
  assert.equal(parsed.status, "starting");
  assert.equal(webhookCalled, false, "endpoint must not be invoked while not-ready");
});

test("webhook reaches the endpoint once gate is open", async () => {
  const gate = new ReadinessGate(["sqlite"]);
  let received = "";
  const endpoint: WebhookEndpoint = {
    path: "/webhooks/test",
    handle: async (req) => { received = req.body.toString("utf-8"); return { status: 200, body: "queued" }; },
  };

  server = new HttpServer({ port, logger: silent, webhooks: new Map([["/webhooks/test", endpoint]]), readinessGate: gate });
  await server.start();
  gate.markReady("sqlite");

  const r = await post("/webhooks/test", '{"hello":"world"}', { "content-type": "application/json" });
  assert.equal(r.status, 200);
  assert.equal(received, '{"hello":"world"}');
});

test("/metrics requires the bearer token when configured", async () => {
  const TOKEN = "supersecret-test-token";
  server = new HttpServer({
    port,
    logger: silent,
    webhooks: new Map(),
    metrics: () => "# metrics\nfoo 1\n",
    metricsToken: TOKEN,
  });
  await server.start();

  let r = await get("/metrics");
  assert.equal(r.status, 401);

  r = await get("/metrics", { authorization: "Bearer wrong-token" });
  assert.equal(r.status, 401);

  r = await get("/metrics", { authorization: `Bearer ${TOKEN}` });
  assert.equal(r.status, 200);
  assert.match(r.body, /foo 1/);
});

test("constructor refuses metrics without metricsToken", () => {
  assert.throws(() => new HttpServer({
    port,
    logger: silent,
    webhooks: new Map(),
    metrics: () => "",
  }), /metricsToken/);
});

test("body too large returns an error and does not invoke the endpoint", async () => {
  let webhookCalled = false;
  const endpoint: WebhookEndpoint = {
    path: "/webhooks/test",
    handle: async () => { webhookCalled = true; return { status: 200 }; },
  };
  server = new HttpServer({ port, logger: silent, webhooks: new Map([["/webhooks/test", endpoint]]) });
  await server.start();

  // Build a 6 MB payload (limit is 5 MB).
  const big = "x".repeat(6 * 1024 * 1024);
  try {
    await post("/webhooks/test", big, { "content-type": "application/json" });
  } catch {
    // Connection may be reset by destroy() - that is acceptable.
  }
  assert.equal(webhookCalled, false);
});

test("unknown POST path returns 404", async () => {
  server = new HttpServer({ port, logger: silent, webhooks: new Map() });
  await server.start();
  const r = await post("/no-such-route", "{}", { "content-type": "application/json" });
  assert.equal(r.status, 404);
});
