import { test } from "node:test";
import assert from "node:assert/strict";
import { diffSpecData } from "../src/adapter-base.js";

const T3 = new Set(["host", "tokenEnv"]);

test("identical data produces empty diff", () => {
  const d = diffSpecData({ host: "github.com", repos: ["a"] }, { host: "github.com", repos: ["a"] }, T3);
  assert.deepEqual(d, { tier1: [], tier3: [] });
});

test("Tier 1 change in repos", () => {
  const d = diffSpecData({ host: "github.com", repos: ["a"] }, { host: "github.com", repos: ["a", "b"] }, T3);
  assert.deepEqual(d.tier1, ["repos"]);
  assert.deepEqual(d.tier3, []);
});

test("Tier 3 change in host", () => {
  const d = diffSpecData({ host: "github.com" }, { host: "ghe.corp" }, T3);
  assert.deepEqual(d.tier1, []);
  assert.deepEqual(d.tier3, ["host"]);
});

test("mixed Tier 1 and Tier 3 changes are both reported", () => {
  const d = diffSpecData(
    { host: "github.com", repos: ["a"], tokenEnv: "GH" },
    { host: "ghe.corp", repos: ["a", "b"], tokenEnv: "GHE" },
    T3,
  );
  assert.deepEqual(d.tier1.sort(), ["repos"]);
  assert.deepEqual(d.tier3.sort(), ["host", "tokenEnv"]);
});

test("nested arrays are compared by content not reference", () => {
  const d = diffSpecData({ repos: ["a", "b"] }, { repos: ["a", "b"] }, T3);
  assert.deepEqual(d, { tier1: [], tier3: [] });
});

test("nested object differences are detected", () => {
  const d = diffSpecData(
    { permissions: { admins: ["U1"] } },
    { permissions: { admins: ["U1", "U2"] } },
    T3,
  );
  assert.deepEqual(d.tier1, ["permissions"]);
});

test("array order matters for diff (current behavior)", () => {
  const d = diffSpecData({ repos: ["a", "b"] }, { repos: ["b", "a"] }, T3);
  assert.deepEqual(d.tier1, ["repos"]);
});

test("undefined vs explicit-null is a diff", () => {
  const d = diffSpecData({ webhookSecretEnv: null }, { webhookSecretEnv: undefined }, T3);
  assert.equal(d.tier1.length + d.tier3.length, 1);
});

test("missing key in one side is a diff", () => {
  const d = diffSpecData({ host: "github.com" }, { host: "github.com", extra: "x" }, T3);
  assert.deepEqual(d.tier1, ["extra"]);
});
