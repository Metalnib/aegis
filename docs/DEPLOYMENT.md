# Deployment

Aegis ships as **one Docker image**. No external services. No sidecars.

## Image contents

```
/opt/aegis/
├── bin/
│   ├── node                     # node 22 runtime
│   └── synopsis                 # .NET single-file R2R binary (linux-x64 or linux-arm64)
├── app/                         # compiled Aegis JS bundle
├── skills/                      # copied from dotnet-episteme-skills at build time
│   ├── dotnet-techne-cross-repo-impact/
│   ├── dotnet-techne-code-review/
│   ├── dotnet-techne-crap-analysis/
│   ├── dotnet-techne-synopsis/
│   └── dotnet-techne-*/
└── entrypoint.sh                # supervisor script

/workspace/                      # volume: cloned repos
/var/lib/aegis/                  # volume: sqlite db + audit log
/var/run/aegis/                  # runtime: unix sockets
```

## Dockerfile (multi-stage, sketch)

```dockerfile
# Stage 1 — build Synopsis from dotnet-episteme-skills
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS synopsis-build
COPY dotnet-episteme-skills/src/synopsis /src
WORKDIR /src
RUN dotnet publish Synopsis/Synopsis.csproj \
    -c Release -r linux-x64 \
    -p:PublishSingleFile=true -p:PublishReadyToRun=true \
    --self-contained true \
    -o /out

# Stage 2 — build Aegis JS
FROM node:22-slim AS aegis-build
WORKDIR /src
COPY aegis/ .
RUN corepack enable && pnpm install --frozen-lockfile && pnpm build

# Stage 3 — runtime (distroless-style)
FROM mcr.microsoft.com/dotnet/runtime-deps:10.0-noble-chiseled
COPY --from=node:22-slim /usr/local/bin/node /opt/aegis/bin/node
COPY --from=synopsis-build /out/synopsis /opt/aegis/bin/synopsis
COPY --from=aegis-build /src/dist /opt/aegis/app
COPY dotnet-episteme-skills/skills /opt/aegis/skills
COPY aegis/docker/entrypoint.sh /opt/aegis/entrypoint.sh
VOLUME ["/workspace", "/var/lib/aegis"]
ENTRYPOINT ["/opt/aegis/entrypoint.sh"]
HEALTHCHECK CMD /opt/aegis/bin/node /opt/aegis/app/healthcheck.js
```

(Final Dockerfile tuned in P1; this captures the intent.)

## Process supervision

Single-image, multi-process. No `systemd`, no `s6-overlay` — Node is the
supervisor:

```
entrypoint.sh
  └── exec node /opt/aegis/app/main.js
          │
          ├── spawns child: synopsis mcp --socket /var/run/aegis/synopsis.sock --watch /workspace
          │       (Node tracks PID; on exit: restart with backoff; on 5 failures: exit)
          │
          ├── starts event bus, queue, worker pool
          │
          └── registers adapters from aegis.config.ts
```

- **Why Node supervises, not a dedicated supervisor:** one less moving part;
  Node can observe crash details (stdio capture), and the only child to
  manage is Synopsis.
- **Signal handling:** SIGTERM → stop accepting jobs → wait for in-flight
  workers (up to 30s) → SIGTERM to Synopsis → exit.
- **Logs:** both Aegis and Synopsis log JSON lines to stdout. Container
  logging captures everything.

## Volumes

| Mount | Purpose | Persist? |
|---|---|---|
| `/workspace` | Cloned git repos | Yes (rebuildable but slow) |
| `/var/lib/aegis` | SQLite queue + audit log | Yes |
| `/var/run/aegis` | Runtime sockets | No (tmpfs) |

## Environment variables (MVP)

Secrets are env vars for MVP. Names are illustrative; final names in
`CONFIGURATION.md`.

| Var | Purpose |
|---|---|
| `AEGIS_CONFIG` | Path to `aegis.config.js` (default `/etc/aegis/aegis.config.js`) |
| `ANTHROPIC_API_KEY` | LLM provider |
| `OPENAI_API_KEY` | Optional, if multi-provider enabled |
| `GITHUB_TOKEN` | Per-code-host adapter |
| `GITLAB_TOKEN` | Per-code-host adapter |
| `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` | Slack Socket Mode |
| `GCHAT_SERVICE_ACCOUNT_JSON` | Google Chat |
| `AEGIS_WORKSPACE` | Override workspace path (default `/workspace`) |
| `AEGIS_DATA_DIR` | Override data dir (default `/var/lib/aegis`) |
| `AEGIS_LOG_LEVEL` | `debug` / `info` / `warn` / `error` |

## Local dev — docker compose

```yaml
# docker-compose.yml (dev convenience only)
services:
  aegis:
    build: .
    image: aegis:dev
    environment:
      AEGIS_CONFIG: /etc/aegis/aegis.config.js
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      GITHUB_TOKEN:      ${GITHUB_TOKEN}
      SLACK_BOT_TOKEN:   ${SLACK_BOT_TOKEN}
      SLACK_APP_TOKEN:   ${SLACK_APP_TOKEN}
    volumes:
      - ./aegis.config.js:/etc/aegis/aegis.config.js:ro
      - workspace:/workspace
      - aegis-data:/var/lib/aegis
    restart: unless-stopped
volumes:
  workspace:
  aegis-data:
```

## Production quick-start

```bash
docker run -d \
  --name aegis \
  -v aegis-workspace:/workspace \
  -v aegis-data:/var/lib/aegis \
  -v ./aegis.config.js:/etc/aegis/aegis.config.js:ro \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  -e GITHUB_TOKEN=$GITHUB_TOKEN \
  -e SLACK_BOT_TOKEN=$SLACK_BOT_TOKEN \
  -e SLACK_APP_TOKEN=$SLACK_APP_TOKEN \
  --restart=unless-stopped \
  aegis:0.1.0
```

## Size and resource targets

- **Image:** target < 250 MB compressed (node ~80 MB, Synopsis ~65 MB,
  skills ~2 MB, app code + deps ~50 MB).
- **RAM:** 1 GB baseline, +~50 MB per active worker, +graph size
  (~50–200 MB for a 20-repo fleet).
- **CPU:** idle < 5%. Under load: worker-bound (LLM calls are the slow path).
- **Disk:** `/workspace` dominated by repo sizes. `/var/lib/aegis` stays
  small (< 100 MB typical; audit log rotates).

## TODOs — production hardening (post-MVP)

**Secret management (post-MVP):**
- Docker secrets: mount `/run/secrets/*` and read files instead of env
  vars. Adapter `ctx.secrets.get(key)` to transparently fall back:
  env var first, `/run/secrets/<key>` second.
- Kubernetes: project secrets as volumes; same fallback path works.
- Vault integration via the same `SecretsProvider` interface.

**Multi-arch builds (post-MVP):**
- Currently specify `linux-x64`. Add `linux-arm64` build via buildx and
  publish multi-arch manifests for Apple Silicon / ARM servers.

**Distroless hardening (post-MVP):**
- Explore `gcr.io/distroless/cc-debian12` as an alternative base;
  `dotnet/runtime-deps` chiseled is close but includes a larger userland.

**Image signing (post-MVP):**
- Cosign / sigstore for released images.

**Health checks (MVP but TODO):**
- `/healthz` implemented as a loopback HTTP endpoint inside Aegis that
  checks Synopsis MCP roundtrip + SQLite ping. Docker `HEALTHCHECK`
  invokes a small node script calling it.

**Log collection:**
- Document Loki / Elastic / OTel collector integration in P3.

**Telemetry / metrics:**
- Prometheus `/metrics` endpoint in P3 with queue depth, job latencies,
  adapter API-call counts, LLM-token usage.
