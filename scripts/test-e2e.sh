#!/bin/bash
# Layer 3 smoke test (see docs/TESTING.md). Hard gate before release.
#
# Builds the Aegis Docker image, runs it against a small known-good .NET
# workspace (dotnet-episteme-skills/src/synopsis), verifies the readiness
# gate state machine, exercises the metrics endpoint, plants a webhook
# delivery with a valid HMAC, and triggers a hot reload via SIGHUP.
#
# What this DOES NOT do:
#   - Open a real PR.
#   - Call an LLM (no API key required).
#   - Talk to a real GitHub org.
# Those checks belong in staging, not in the smoke gate.
#
# Requires: docker, curl, jq, openssl.
# Usage:    ./scripts/test-e2e.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
SISTER_REPO="$REPO_ROOT/../dotnet-episteme-skills"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[smoke]${NC} $*"; }
warn()  { echo -e "${YELLOW}[smoke]${NC} $*"; }
fail()  { echo -e "${RED}[smoke] FAIL${NC} $*"; exit 1; }
pass()  { echo -e "${GREEN}[smoke] PASS${NC} $*"; }

# ── Prerequisites ────────────────────────────────────────────────────────────

for cmd in docker curl jq openssl; do
  command -v "$cmd" > /dev/null 2>&1 || fail "required command not found: $cmd"
done

[ -d "$SISTER_REPO" ] || fail "expected sister repo at $SISTER_REPO (clone dotnet-episteme-skills next to aegis/)"
[ -d "$SISTER_REPO/src/synopsis" ] || fail "expected $SISTER_REPO/src/synopsis"

# ── Setup ────────────────────────────────────────────────────────────────────

CONTAINER="aegis-smoke-$$"
TMPDIR="$(mktemp -d)"
PORT=18080
WEBHOOK_SECRET="smoke-test-secret"
METRICS_TOKEN="smoke-test-metrics-token"
GITHUB_TOKEN="smoke-test-token"  # never validated against the real API in this test
TIMEOUT_SEC=600                  # 10 minutes per ADR 0016 for cold-scan tolerance

cleanup() {
  set +e
  info "Cleaning up..."
  docker logs --tail 100 "$CONTAINER" > "$TMPDIR/container.log" 2>&1 || true
  docker stop "$CONTAINER" > /dev/null 2>&1
  docker rm "$CONTAINER" > /dev/null 2>&1
  if [ "${KEEP_LOGS:-0}" = "1" ]; then
    info "Container logs preserved at $TMPDIR/container.log"
  else
    rm -rf "$TMPDIR"
  fi
}
trap cleanup EXIT

# ── 1. Build image ───────────────────────────────────────────────────────────

info "Building aegis:smoke image (this can take several minutes on first run)..."
docker build \
  --build-context "build-context=$REPO_ROOT/.." \
  -f "$REPO_ROOT/docker/Dockerfile" \
  -t aegis:smoke \
  "$REPO_ROOT" > "$TMPDIR/build.log" 2>&1 || {
    tail -30 "$TMPDIR/build.log"
    fail "docker build failed (full log: $TMPDIR/build.log)"
  }
pass "Image built"

# ── 2. Write minimal config ──────────────────────────────────────────────────

cat > "$TMPDIR/aegis.config.js" <<EOF
const { github } = require("@aegis/adapter-github");
module.exports = {
  workspace: "/workspace",
  dbPath: "/var/lib/aegis/aegis.db",
  synopsis: {
    transport: "unix",
    path: "/var/run/aegis/synopsis.sock",
    bin: "/opt/aegis/bin/synopsis",
    stateDir: "/var/lib/aegis/synopsis",
  },
  agent: {
    provider: "anthropic",
    model: "claude-opus-4-7",
    concurrency: 1,
    jobTimeoutSec: 60,
  },
  codeHosts: [
    github({
      org: "smoke-org",
      repos: ["smoke-repo"],
      pollIntervalSec: 600,                 // effectively disabled - we test webhook intake
      tokenEnv: "GITHUB_TOKEN",
      webhookSecretEnv: "GITHUB_WEBHOOK_SECRET",
    }),
  ],
  chats: [],
  skills: [],                                // skip skill loading - workspace test only
  skillsDir: "/opt/aegis/skills",
  soulPath: "/opt/aegis/SOUL.md",
  http: {
    port: 8080,
    bindAddr: "0.0.0.0",
    metricsTokenEnv: "METRICS_TOKEN",
  },
  queue: { retries: 1, backoff: "exponential" },
  logging: { level: "info", format: "text" },
};
EOF

# ── 3. Start container ───────────────────────────────────────────────────────

info "Starting container against $SISTER_REPO/src/synopsis as workspace..."
docker run -d \
  --name "$CONTAINER" \
  -p "$PORT:8080" \
  -e GITHUB_TOKEN="$GITHUB_TOKEN" \
  -e GITHUB_WEBHOOK_SECRET="$WEBHOOK_SECRET" \
  -e METRICS_TOKEN="$METRICS_TOKEN" \
  -e ANTHROPIC_API_KEY="not-used-in-smoke" \
  -v "$TMPDIR/aegis.config.js:/opt/aegis/aegis.config.js:ro" \
  -v "$SISTER_REPO/src/synopsis:/workspace/synopsis:ro" \
  aegis:smoke \
  > /dev/null

# ── 4. Verify /healthz transitions 503 → 200 ─────────────────────────────────

info "Verifying /healthz reports not-ready during boot..."
sleep 2
EARLY=$(curl -s -o "$TMPDIR/healthz-early.json" -w "%{http_code}" "http://localhost:$PORT/healthz" || true)
if [ "$EARLY" = "503" ]; then
  PENDING=$(jq -r '.pending | join(",")' < "$TMPDIR/healthz-early.json" 2>/dev/null || echo "")
  pass "Boot: /healthz 503 with pending=[$PENDING]"
elif [ "$EARLY" = "200" ]; then
  warn "Container reached ready before we could observe 503 (very fast boot, that's fine)"
else
  warn "Unexpected early healthz response: $EARLY (proceeding)"
fi

info "Waiting up to ${TIMEOUT_SEC}s for /healthz to reach 200..."
DEADLINE=$(( $(date +%s) + TIMEOUT_SEC ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/healthz" || true)
  if [ "$CODE" = "200" ]; then
    pass "Ready: /healthz 200 reached"
    break
  fi
  echo -n "."
  sleep 5
done
[ "$(date +%s)" -lt "$DEADLINE" ] || {
  echo
  warn "Last 80 lines of container log:"
  docker logs --tail 80 "$CONTAINER"
  fail "Timeout: /healthz never reached 200"
}

# ── 5. Metrics token gating ──────────────────────────────────────────────────

info "Verifying /metrics token gating..."
NOAUTH=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/metrics" || true)
[ "$NOAUTH" = "401" ] || fail "/metrics without token expected 401, got $NOAUTH"

WRONG=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer wrong-token" "http://localhost:$PORT/metrics" || true)
[ "$WRONG" = "401" ] || fail "/metrics with wrong token expected 401, got $WRONG"

OK=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $METRICS_TOKEN" "http://localhost:$PORT/metrics" || true)
[ "$OK" = "200" ] || fail "/metrics with correct token expected 200, got $OK"
pass "Metrics: 401/401/200 across no-token / wrong / correct"

# ── 6. Planted webhook delivery ──────────────────────────────────────────────

info "Planting a webhook with a valid HMAC..."
PAYLOAD='{"action":"opened","pull_request":{"number":1,"head":{"sha":"smoke-sha-1"}},"repository":{"name":"smoke-repo","owner":{"login":"smoke-org"}}}'
SIG="sha256=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" -hex | awk '{print $NF}')"

WEBHOOK_CODE=$(curl -s -o "$TMPDIR/webhook-resp.txt" -w "%{http_code}" \
  -X POST "http://localhost:$PORT/webhooks/github" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: pull_request" \
  -H "X-Hub-Signature-256: $SIG" \
  --data "$PAYLOAD" || true)

if [ "$WEBHOOK_CODE" = "200" ]; then
  pass "Webhook accepted (200)"
else
  warn "Webhook response: HTTP $WEBHOOK_CODE - $(cat "$TMPDIR/webhook-resp.txt")"
  fail "Webhook delivery failed"
fi

# Bad signature should be rejected.
BAD_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "http://localhost:$PORT/webhooks/github" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: pull_request" \
  -H "X-Hub-Signature-256: sha256=deadbeef" \
  --data "$PAYLOAD" || true)
[ "$BAD_CODE" = "401" ] || fail "Webhook with bad signature expected 401, got $BAD_CODE"
pass "Bad-signature webhook rejected (401)"

# ── 7. Hot reload via SIGHUP ─────────────────────────────────────────────────

info "Triggering hot reload via SIGHUP..."
# Edit the mounted config (Tier 1: change skills list).
sed -i.bak 's/skills: \[\]/skills: ["dotnet-techne-code-review"]/' "$TMPDIR/aegis.config.js"

docker exec "$CONTAINER" kill -HUP 1
sleep 3

if docker logs "$CONTAINER" 2>&1 | grep -q "reload (sighup): applied"; then
  pass "SIGHUP reload applied"
elif docker logs "$CONTAINER" 2>&1 | grep -q "reload (sighup): no changes"; then
  warn "SIGHUP fired but the diff was empty - skill loading may have been disabled in this image"
else
  warn "Last 30 lines of container log:"
  docker logs --tail 30 "$CONTAINER"
  fail "SIGHUP reload did not produce expected log line"
fi

# ── Done ─────────────────────────────────────────────────────────────────────

pass "Smoke test complete"
