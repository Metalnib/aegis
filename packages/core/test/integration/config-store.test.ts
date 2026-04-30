import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../../src/config-store.js";
import { loadConfig, type AegisConfig } from "../../src/config.js";

// Adapter-shaped fixture. Real adapter classes need init/network; the
// ConfigStore only needs id + getSpec/diffSpec for change classification,
// so a small spec-aware stub is enough.
function adapter(id: string, type: string, data: Record<string, unknown> = {}, tier3Keys: string[] = []) {
  return {
    id,
    init: async () => {},
    dispose: async () => {},
    getSpec: () => ({ type, id, data }),
    diffSpec: (next: { data: Record<string, unknown> }) => {
      const tier1: string[] = [];
      const tier3: string[] = [];
      const all = new Set([...Object.keys(data), ...Object.keys(next.data ?? {})]);
      for (const k of all) {
        if (JSON.stringify(data[k]) === JSON.stringify(next.data?.[k])) continue;
        if (tier3Keys.includes(k)) tier3.push(k); else tier1.push(k);
      }
      return { tier1, tier3 };
    },
  };
}

const silent = { debug() {}, info() {}, warn() {}, error() {} };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aegis-cs-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function baseConfig(over: Partial<AegisConfig> = {}): AegisConfig {
  return loadConfig({
    workspace: "/tmp/ws",
    dbPath: "/tmp/db",
    synopsis: { transport: "unix", path: "/tmp/sock" },
    agent: { provider: "anthropic", model: "claude" },
    codeHosts: [adapter("github", "github", { host: "github.com", repos: ["a"] })],
    chats: [],
    skills: ["x"],
    skillsDir: "/skills",
    soulPath: "/soul",
    queue: { retries: 3, backoff: "exponential" },
    logging: { level: "info", format: "json" },
    ...over,
  } as unknown as AegisConfig) as AegisConfig;
}

test("manual reload picks up the new config from the loader", async () => {
  const initial = baseConfig();
  let nextRaw: AegisConfig = baseConfig({ skills: ["x", "y"] });

  const store = new ConfigStore({
    configPath: join(dir, "fake-not-watched.js"),
    loader: () => nextRaw,
    initial,
    logger: silent,
  });

  let observed: { applied?: string[] } | null = null;
  store.subscribe(async (change) => {
    observed = { applied: change.skillsChanged ? ["skills"] : [] };
  });

  const outcome = await store.reload("manual");
  assert.equal(outcome.kind, "applied");
  assert.deepEqual(observed?.applied, ["skills"]);
  assert.deepEqual(store.get().skills, ["x", "y"]);
});

test("reload refuses Tier 3 changes and keeps the previous config", async () => {
  const initial = baseConfig();
  let nextRaw: AegisConfig = baseConfig({ workspace: "/tmp/different" });

  const store = new ConfigStore({
    configPath: join(dir, "x.js"),
    loader: () => nextRaw,
    initial,
    logger: silent,
  });

  let subscriberFired = false;
  store.subscribe(async () => { subscriberFired = true; });

  const outcome = await store.reload("manual");
  assert.equal(outcome.kind, "tier3-refused");
  assert.equal(subscriberFired, false, "subscribers must not fire on Tier 3 refuse");
  // Previous config still active.
  assert.equal(store.get().workspace, "/tmp/ws");
});

test("reload reports validation errors without leaking the offending value", async () => {
  const initial = baseConfig();
  // Loader returns an invalid config: codeHosts has an entry without `id`.
  const store = new ConfigStore({
    configPath: join(dir, "x.js"),
    loader: () => ({
      ...initial,
      codeHosts: [{ /* missing id, has a SECRET-LOOKING field */ token: "sk-LEAKED-SHOULD-NOT-LOG" }],
    }),
    initial,
    logger: silent,
  });

  const outcome = await store.reload("manual");
  assert.equal(outcome.kind, "validation-error");
  // The error string must NOT contain the secret value.
  if (outcome.kind === "validation-error") {
    assert.ok(!outcome.error.includes("sk-LEAKED-SHOULD-NOT-LOG"), `error must not echo secret-looking values, got: ${outcome.error}`);
  }
});

test("reload reports load errors when the loader throws", async () => {
  const initial = baseConfig();
  const store = new ConfigStore({
    configPath: join(dir, "x.js"),
    loader: () => { throw new Error("boom"); },
    initial,
    logger: silent,
  });

  const outcome = await store.reload("manual");
  assert.equal(outcome.kind, "load-error");
  if (outcome.kind === "load-error") assert.match(outcome.error, /boom/);
});

test("reload is no-changes when the new config matches", async () => {
  const initial = baseConfig();
  const store = new ConfigStore({
    configPath: join(dir, "x.js"),
    loader: () => initial,
    initial,
    logger: silent,
  });

  const outcome = await store.reload("manual");
  assert.equal(outcome.kind, "no-changes");
});

test("file watch triggers reload after debounce", async () => {
  const { utimesSync } = await import("node:fs");
  const path = join(dir, "config.json");
  let raw: AegisConfig = baseConfig();
  writeFileSync(path, JSON.stringify(raw), "utf-8");
  // Backdate mtime so the next touch is unambiguously newer.
  const past = new Date(Date.now() - 60_000);
  utimesSync(path, past, past);

  const store = new ConfigStore({
    configPath: path,
    loader: () => raw,
    initial: raw,
    logger: silent,
    debounceMs: 50,
  });

  let reloads = 0;
  store.subscribe(async () => { reloads++; });

  store.startWatching();

  raw = baseConfig({ skills: ["x", "y", "z"] });
  writeFileSync(path, JSON.stringify(raw), "utf-8");
  // Force mtime to "now" so fs.watchFile's polling sees an unambiguous change.
  const now = new Date();
  utimesSync(path, now, now);

  // Poll interval is 2s, debounce is 50ms; allow a generous buffer.
  await new Promise(r => setTimeout(r, 5_000));
  store.stop();

  assert.ok(reloads >= 1, `expected at least one reload, got ${reloads}`);
  assert.deepEqual(store.get().skills, ["x", "y", "z"]);
});

test("notifyOps callback is invoked on tier3-refused reloads", async () => {
  const initial = baseConfig();
  let nextRaw: AegisConfig = baseConfig({ workspace: "/tmp/different" });
  const opsMessages: string[] = [];

  const store = new ConfigStore({
    configPath: join(dir, "x.js"),
    loader: () => nextRaw,
    initial,
    logger: silent,
    notifyOps: async (text) => { opsMessages.push(text); },
  });

  await store.reload("manual");
  assert.equal(opsMessages.length, 1);
  assert.match(opsMessages[0]!, /Restart required/i);
});
