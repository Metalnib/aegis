import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvSecrets } from "../src/secrets.js";

const VAR = "AEGIS_TEST_SECRET";
const FILE_VAR = "AEGIS_TEST_SECRET_FILE";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aegis-secrets-"));
  delete process.env[VAR];
  delete process.env[FILE_VAR];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env[VAR];
  delete process.env[FILE_VAR];
});

test("returns env var value when set", () => {
  process.env[VAR] = "plain-value";
  const s = new EnvSecrets();
  assert.equal(s.get(VAR), "plain-value");
});

test("throws when neither env nor _FILE is set", () => {
  const s = new EnvSecrets();
  assert.throws(() => s.get(VAR), /not set/);
});

test("throws when env var is empty string", () => {
  process.env[VAR] = "";
  const s = new EnvSecrets();
  assert.throws(() => s.get(VAR), /not set/);
});

test("_FILE indirection reads from disk", () => {
  const path = join(dir, "secret.txt");
  writeFileSync(path, "from-file-value\n", "utf-8");
  process.env[FILE_VAR] = path;

  const s = new EnvSecrets();
  assert.equal(s.get(VAR), "from-file-value", "trailing newline should be trimmed");
});

test("_FILE wins over env when both are set", () => {
  process.env[VAR] = "env-loses";
  const path = join(dir, "secret.txt");
  writeFileSync(path, "file-wins", "utf-8");
  process.env[FILE_VAR] = path;

  const s = new EnvSecrets();
  assert.equal(s.get(VAR), "file-wins");
});

test("_FILE pointing at missing file throws with the path in the message", () => {
  process.env[FILE_VAR] = join(dir, "does-not-exist");
  const s = new EnvSecrets();
  assert.throws(() => s.get(VAR), /does-not-exist/);
});

test("_FILE pointing at an empty file throws", () => {
  const path = join(dir, "empty.txt");
  writeFileSync(path, "", "utf-8");
  process.env[FILE_VAR] = path;

  const s = new EnvSecrets();
  assert.throws(() => s.get(VAR), /empty/);
});

test("file read result is cached - second call does not re-read", () => {
  const path = join(dir, "secret.txt");
  writeFileSync(path, "first-read", "utf-8");
  process.env[FILE_VAR] = path;

  const s = new EnvSecrets();
  assert.equal(s.get(VAR), "first-read");

  // Modify file on disk; cached value should still come back.
  writeFileSync(path, "second-read-ignored", "utf-8");
  assert.equal(s.get(VAR), "first-read", "value must be cached for process lifetime");
});

test("file rotation notice is logged once", () => {
  const path = join(dir, "secret.txt");
  writeFileSync(path, "value", "utf-8");
  process.env[FILE_VAR] = path;

  const messages: string[] = [];
  const s = new EnvSecrets({ info: (m) => messages.push(m) });

  s.get(VAR);
  s.get(VAR); // cached, should not log again

  const notices = messages.filter(m => m.includes("rotation requires"));
  assert.equal(notices.length, 1, "rotation notice should appear exactly once");
});
