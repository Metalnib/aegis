#!/bin/bash
# Smoke test: start Aegis against a local Synopsis mock and open a test PR.
# Requires: docker, gh CLI, jq, nc (netcat).
# Usage: GITHUB_TOKEN=... ANTHROPIC_API_KEY=... ./scripts/test-e2e.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[e2e]${NC} $*"; }
warn()  { echo -e "${YELLOW}[e2e]${NC} $*"; }
fail()  { echo -e "${RED}[e2e] FAIL${NC} $*"; exit 1; }
pass()  { echo -e "${GREEN}[e2e] PASS${NC} $*"; }

# ── Prerequisites ────────────────────────────────────────────────────────────
for cmd in docker gh jq; do
  command -v "$cmd" > /dev/null 2>&1 || fail "required command not found: $cmd"
done

: "${GITHUB_TOKEN:?GITHUB_TOKEN is required}"
: "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY is required}"

E2E_REPO="${E2E_REPO:-}"
if [ -z "$E2E_REPO" ]; then
  fail "E2E_REPO is required (e.g. myorg/test-repo-a). Set it to a repo you control."
fi

# ── Build image ──────────────────────────────────────────────────────────────
info "Building aegis:e2e image..."
docker build \
  --build-context "build-context=$REPO_ROOT/.." \
  -f "$REPO_ROOT/docker/Dockerfile" \
  -t aegis:e2e \
  "$REPO_ROOT"

# ── Create a test PR ─────────────────────────────────────────────────────────
info "Creating test branch and PR in $E2E_REPO..."

BRANCH="aegis-e2e-$(date +%s)"
OWNER="${E2E_REPO%%/*}"
REPO_NAME="${E2E_REPO##*/}"

# Make a trivial commit
tmpdir=$(mktemp -d)
gh repo clone "$E2E_REPO" "$tmpdir" -- --depth=1 --quiet
cd "$tmpdir"

git checkout -b "$BRANCH"
echo "// e2e test $(date)" >> aegis-e2e.txt
git add aegis-e2e.txt
git commit -m "chore: aegis e2e test"
git push origin "$BRANCH" --quiet

PR_URL=$(gh pr create \
  --repo "$E2E_REPO" \
  --title "Aegis e2e test ($(date +%Y-%m-%d))" \
  --body  "Automated e2e test. Close after review appears." \
  --head  "$BRANCH" \
  --base  "main" \
  2>&1 | tail -1)

PR_NUMBER=$(basename "$PR_URL")
info "Created PR #$PR_NUMBER at $PR_URL"
cd "$REPO_ROOT"

# ── Write minimal config ─────────────────────────────────────────────────────
SOCK_PATH="/tmp/aegis-e2e-synopsis.sock"
CONFIG_FILE="$tmpdir/aegis.config.js"

cat > "$CONFIG_FILE" <<EOF
const { github } = require("@aegis/adapter-github");
module.exports = {
  workspace: "/workspace",
  synopsis: { transport: "unix", path: "/var/run/aegis/synopsis.sock" },
  agent: { provider: "anthropic", model: "claude-opus-4-7", concurrency: 1, jobTimeoutSec: 300 },
  codeHosts: [
    github({ org: "$OWNER", repos: ["$REPO_NAME"], pollIntervalSec: 30, tokenEnv: "GITHUB_TOKEN" })
  ],
  chats: [],
  skills: ["dotnet-techne-code-review"],
  queue: { retries: 1, backoff: "exponential" },
  logging: { level: "info", format: "text" },
};
EOF

# ── Start Aegis container ────────────────────────────────────────────────────
info "Starting Aegis container (will skip Synopsis, watching logs)..."
CONTAINER=$(docker run -d \
  --name "aegis-e2e-$$" \
  -e GITHUB_TOKEN="$GITHUB_TOKEN" \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -e SYNOPSIS_BIN="/bin/true" \
  -v "$CONFIG_FILE:/aegis/aegis.config.js:ro" \
  aegis:e2e \
  node /aegis/packages/cli/dist/bin.js serve /aegis/aegis.config.js \
  2>&1 || echo "")

if [ -z "$CONTAINER" ]; then
  fail "Failed to start Aegis container"
fi

cleanup() {
  info "Cleaning up..."
  docker stop "$CONTAINER" > /dev/null 2>&1 || true
  docker rm "$CONTAINER" > /dev/null 2>&1 || true
  gh pr close "$PR_NUMBER" --repo "$E2E_REPO" --delete-branch 2>/dev/null || true
  rm -rf "$tmpdir"
}
trap cleanup EXIT

# ── Wait for review ──────────────────────────────────────────────────────────
info "Waiting up to 5 minutes for Aegis to post a review on PR #$PR_NUMBER..."
DEADLINE=$(( $(date +%s) + 300 ))

while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  REVIEW_COUNT=$(gh pr view "$PR_NUMBER" \
    --repo "$E2E_REPO" \
    --json reviews \
    --jq '.reviews | length' 2>/dev/null || echo "0")

  if [ "$REVIEW_COUNT" -gt 0 ]; then
    pass "Aegis posted a review on PR #$PR_NUMBER"
    SEVERITY=$(gh pr view "$PR_NUMBER" \
      --repo "$E2E_REPO" \
      --json reviews \
      --jq '.reviews[-1].body' 2>/dev/null | grep -oP '(Critical|High|Medium|Low|Unknown)' | head -1 || echo "Unknown")
    pass "Severity: $SEVERITY"
    break
  fi

  echo -n "."
  sleep 10
done

if [ "$(date +%s)" -ge "$DEADLINE" ]; then
  warn "Timed out waiting for review. Container logs:"
  docker logs --tail 50 "$CONTAINER"
  fail "No review posted within 5 minutes"
fi

# ── Supervisor resilience check ──────────────────────────────────────────────
info "Checking container is still healthy..."
docker inspect "$CONTAINER" --format "{{.State.Status}}" | grep -q "running" \
  && pass "Container still running" \
  || fail "Container exited unexpectedly"

pass "E2E complete"
