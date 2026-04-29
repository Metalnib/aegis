import { test } from "node:test";
import assert from "node:assert/strict";
import { computeChangeSet } from "../src/config-store.js";
import type { AegisConfig } from "../src/config.js";

// A minimal valid AegisConfig fixture. The change-set algorithm only inspects
// the fields it cares about (workspace, dbPath, synopsis, http, skillsDir,
// soulPath, agent, logging, queue, skills, codeHosts, chats), so we don't need
// real adapter instances - we mock just enough surface for the diff to work.

function adapter(id: string, type: string, data: Record<string, unknown> = {}, tier3Keys: string[] = []) {
  return {
    id,
    init: async () => {},
    dispose: async () => {},
    getSpec: () => ({ type, id, data }),
    diffSpec: (next: { data: Record<string, unknown> }) => {
      const tier1: string[] = [];
      const tier3: string[] = [];
      const allKeys = new Set([...Object.keys(data), ...Object.keys(next.data ?? {})]);
      for (const key of allKeys) {
        if (JSON.stringify(data[key]) === JSON.stringify(next.data?.[key])) continue;
        if (tier3Keys.includes(key)) tier3.push(key); else tier1.push(key);
      }
      return { tier1, tier3 };
    },
  };
}

function baseConfig(over: Partial<AegisConfig> = {}): AegisConfig {
  return {
    workspace: "/workspace",
    dbPath: "/var/lib/aegis/aegis.db",
    synopsis: { transport: "unix", path: "/var/run/aegis/synopsis.sock", stateDir: "/var/lib/aegis/synopsis" },
    agent: { provider: "anthropic", model: "claude", concurrency: 4, jobTimeoutSec: 600, providerLimits: {}, customProviders: {} },
    skills: ["a", "b"],
    skillsDir: "/opt/aegis/skills",
    soulPath: "/opt/aegis/SOUL.md",
    queue: { retries: 3, backoff: "exponential" },
    logging: { level: "info", format: "json" },
    codeHosts: [],
    chats: [],
    ...over,
  } as unknown as AegisConfig;
}

test("identical configs produce no changes", () => {
  const a = baseConfig();
  const b = baseConfig();
  const cs = computeChangeSet(a, b);
  assert.equal(cs.tier3Fields.length, 0);
  assert.equal(cs.agentChanged, false);
  assert.equal(cs.loggingChanged, false);
  assert.equal(cs.queueChanged, false);
  assert.equal(cs.skillsChanged, false);
});

test("agent change is flagged Tier 1+2", () => {
  const a = baseConfig();
  const b = baseConfig({ agent: { ...a.agent, model: "claude-other" } });
  const cs = computeChangeSet(a, b);
  assert.equal(cs.agentChanged, true);
  assert.equal(cs.tier3Fields.length, 0);
});

test("skills change is flagged Tier 1+2", () => {
  const a = baseConfig();
  const b = baseConfig({ skills: ["a", "b", "c"] });
  const cs = computeChangeSet(a, b);
  assert.equal(cs.skillsChanged, true);
});

test("workspace change is Tier 3", () => {
  const a = baseConfig();
  const b = baseConfig({ workspace: "/new" });
  const cs = computeChangeSet(a, b);
  assert.ok(cs.tier3Fields.includes("workspace"));
});

test("dbPath change is Tier 3", () => {
  const a = baseConfig();
  const b = baseConfig({ dbPath: "/elsewhere/aegis.db" });
  const cs = computeChangeSet(a, b);
  assert.ok(cs.tier3Fields.includes("dbPath"));
});

test("http port change is Tier 3", () => {
  const a = baseConfig({ http: { port: 8080, bindAddr: "0.0.0.0" } });
  const b = baseConfig({ http: { port: 9090, bindAddr: "0.0.0.0" } });
  const cs = computeChangeSet(a, b);
  assert.ok(cs.tier3Fields.includes("http"));
});

test("synopsis stateDir change is Tier 3", () => {
  const a = baseConfig();
  const b = baseConfig({ synopsis: { ...a.synopsis, stateDir: "/different" } });
  const cs = computeChangeSet(a, b);
  assert.ok(cs.tier3Fields.includes("synopsis"));
});

test("adding a code host is Tier 3", () => {
  const a = baseConfig();
  const b = baseConfig({ codeHosts: [adapter("github", "github", { host: "github.com" })] });
  const cs = computeChangeSet(a, b);
  assert.ok(cs.tier3Fields.some(f => f.startsWith("codeHost:")));
});

test("removing a code host is Tier 3", () => {
  const a = baseConfig({ codeHosts: [adapter("github", "github", { host: "github.com" })] });
  const b = baseConfig({ codeHosts: [] });
  const cs = computeChangeSet(a, b);
  assert.ok(cs.tier3Fields.some(f => f.includes(":removed")));
});

test("modifying a code host repos is Tier 1+2 (delegates to diffSpec)", () => {
  const oldHost = adapter("github", "github", { repos: ["a", "b"] });
  const newHost = adapter("github", "github", { repos: ["a", "b", "c"] });
  const a = baseConfig({ codeHosts: [oldHost] });
  const b = baseConfig({ codeHosts: [newHost] });
  const cs = computeChangeSet(a, b);
  assert.equal(cs.tier3Fields.length, 0, "no top-level Tier 3");
  assert.ok(cs.codeHostSpecs.has("github"), "code host should appear in change set");
  assert.equal(cs.adapterTier3.size, 0, "no adapter-level Tier 3");
});

test("modifying a code host tier3-key (host) raises adapter Tier 3", () => {
  const oldHost = adapter("github", "github", { host: "github.com", repos: [] }, ["host"]);
  const newHost = adapter("github", "github", { host: "ghe.corp", repos: [] }, ["host"]);
  const a = baseConfig({ codeHosts: [oldHost] });
  const b = baseConfig({ codeHosts: [newHost] });
  const cs = computeChangeSet(a, b);
  const t3 = cs.adapterTier3.get("github");
  assert.ok(t3 && t3.includes("host"), "host change should be Tier 3");
});
