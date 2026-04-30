# Deployment

Aegis ships as one Docker image. No external services. No sidecars.

## Image contents

```
/aegis/                          # app root (node_modules + packages live here)
├── packages/                    # compiled Aegis JS bundle
├── node_modules/
│   └── @aegis/...               # symlinks back to /aegis/packages/* so user
│                                # configs can `import { github } from "@aegis/adapter-github"`
└── aegis.config.js              # mounted by the operator (read-only)

/opt/aegis/                      # static, baked-in resources
├── bin/
│   ├── synopsis                 # .NET single-file binary (linux-x64 or linux-arm64)
│   └── BuildHost-netcore/       # MSBuild host that ships next to the binary
├── skills/                      # dotnet-techne-* skills, copied from dotnet-episteme-skills
└── SOUL.md                      # agent identity prompt

/usr/share/dotnet/               # .NET SDK (runtime + targeting packs, needed by Synopsis
                                 # for Roslyn project loading via MSBuild)
/entrypoint.sh
/healthcheck.sh

/workspace/                      # volume: cloned repos
/var/lib/aegis/                  # volume: sqlite db + audit log
/var/run/aegis/                  # runtime: unix sockets
```

The split is deliberate: `/aegis/` is the JS workspace root and is what
Node's module resolution walks. The user-mounted config has to live
under it (typically `/aegis/aegis.config.js`) so `import "@aegis/..."`
resolves correctly. `/opt/aegis/` is the static-resource sibling - the
synopsis binary, skills, and SOUL.md - none of which need to be on the
JS resolution path.

The runtime image now ships the .NET SDK (BuildHost-netcore plus the dotnet
runtime and targeting packs). Synopsis loads .NET projects through Roslyn via
MSBuild, and MSBuild needs a real SDK on disk - a slim runtime-only base is
not enough. A future image may carry several SDK majors side by side (for
example .NET 8 or 9 alongside 10) so workspaces with mixed target frameworks
load cleanly.

## Dockerfile

See [`docker/Dockerfile`](../docker/Dockerfile) for the actual definition. In
brief, it does:

- Multi-stage, multi-arch via `TARGETARCH`. The Synopsis publish picks
  `linux-x64` or `linux-arm64` to match the platform `docker buildx` is
  building for.
- Single-file R2R publish of Synopsis from `dotnet-episteme-skills/src/synopsis`,
  with `BuildHost-netcore` copied next to the binary.
- `pnpm build` for Aegis, then a copy of the resulting `packages/` tree into
  `/aegis/packages` and the symlink trick: `/aegis/node_modules/@aegis/<pkg>`
  points to `/aegis/packages/<pkg>` so user configs can do
  `import { github } from "@aegis/adapter-github"` and Node's module
  resolution finds it.
- Runtime base installs `libicu72` and the .NET SDK for MSBuild.
- Skills copied from `dotnet-episteme-skills/skills` into the image.

## Process supervision

Single-image, multi-process. No `systemd`, no `s6-overlay` - Node is the
supervisor:

```
entrypoint.sh
  └── exec node /aegis/packages/cli/dist/bin.js serve $AEGIS_CONFIG
          │
          ├── spawns child: synopsis mcp --socket /var/run/aegis/synopsis.sock --watch /workspace
          │       (Node tracks PID; on exit: restart with backoff; on 5 failures: exit)
          │
          ├── starts event bus, queue, worker pool
          │
          └── registers adapters from aegis.config.js
```

- Why Node supervises, not a dedicated supervisor: one less moving part. Node
  can observe crash details (stdio capture), and the only child to manage is
  Synopsis.
- Signal handling: SIGTERM stops accepting jobs, waits for in-flight workers
  (up to 30s), sends SIGTERM to Synopsis, exits.
- Logs: both Aegis and Synopsis log JSON lines to stdout. Container logging
  captures everything.

### Startup probe

The startup probe absorbs the Synopsis cold-scan time. Helm chart
defaults: `initialDelaySeconds=10`, `periodSeconds=10`,
`failureThreshold=60` (10 minutes total tolerance). For larger workspaces
or constrained hardware, raise `failureThreshold`. Underestimating
triggers restart-flapping. The asymmetry favors generosity.

See [ARCHITECTURE.md](ARCHITECTURE.md) "Startup readiness" for the
contract: what subsystems must be up, how `/healthz` and webhook intake
behave during boot, and the 503-vs-buffer tradeoff.

## Volumes

| Mount | Purpose | Persist? |
|---|---|---|
| `/workspace` | Cloned git repos | Yes (rebuildable but slow) |
| `/var/lib/aegis` | SQLite queue + audit log | Yes |
| `/var/run/aegis` | Runtime sockets | No (tmpfs) |

## Environment variables

Required for every deployment:

| Var | Purpose |
|---|---|
| `AEGIS_CONFIG` | Path to `aegis.config.js` inside the container. Defaults to `/aegis/aegis.config.js`. Override only if you mount the config somewhere else. The default exists because the user's config typically does `import { github } from "@aegis/adapter-github"`, and Node resolves that import via `/aegis/node_modules/@aegis/...` symlinks. Mounting at `/etc/aegis/...` or `/opt/aegis/...` will fail at config load. |

Per code-host adapter (each adapter declares its own env name through
`tokenEnv` / `webhookSecretEnv`. The defaults below are what the bundled
adapters use):

| Var | Purpose |
|---|---|
| `GITHUB_TOKEN` | GitHub PAT or app token. Override the var name via the adapter's `tokenEnv`. |
| `GITHUB_WEBHOOK_SECRET` | HMAC secret for GitHub webhook verification. |
| `GITLAB_TOKEN` | GitLab PAT. |
| `GITLAB_WEBHOOK_SECRET` | HMAC secret for GitLab webhook verification. |

Per chat adapter:

| Var | Purpose |
|---|---|
| `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` | Slack Socket Mode. |
| `GCHAT_WEBHOOK_<SPACEID>` | One per Google Chat space. |

Per LLM provider:

| Var | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | If using Anthropic. |
| `OPENAI_API_KEY` | If using OpenAI. |
| `<your-provider-key-env>` | For custom providers, the env var name comes from `agent.customProviders.<name>.apiKeyEnv` in your config. Common examples are `VULTR_API_KEY`, `OPENROUTER_API_KEY`, but the name is whatever you set. Pi Agent's built-in providers use the standard names listed above. |

Optional:

| Var | Purpose |
|---|---|
| `METRICS_TOKEN` | Bearer token for `/metrics` and `/dashboard`. Required if `http.metricsTokenEnv` is set in config. |

(`AEGIS_WORKSPACE`, `AEGIS_DATA_DIR`, and `AEGIS_LOG_LEVEL` were listed in
earlier drafts. The code does not read them. Use the corresponding fields in
`aegis.config.js` instead: `workspace`, `dbPath`, `logging.level`.)

## Local dev - docker compose

```yaml
# docker-compose.yml (dev convenience only)
services:
  aegis:
    build: .
    image: aegis:dev
    environment:
      # Pass whatever env vars your aegis.config.js references. Examples below;
      # the actual set depends on which adapters and providers your config wires up.
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      GITHUB_TOKEN:      ${GITHUB_TOKEN}
      SLACK_BOT_TOKEN:   ${SLACK_BOT_TOKEN}
      SLACK_APP_TOKEN:   ${SLACK_APP_TOKEN}
    volumes:
      - ./aegis.config.js:/aegis/aegis.config.js:ro
      - workspace:/workspace
      - aegis-data:/var/lib/aegis
    restart: unless-stopped
volumes:
  workspace:
  aegis-data:
```

## Production quick-start

Anthropic (built-in provider):

```bash
docker run -d --name aegis \
  -v $PWD/aegis.config.js:/aegis/aegis.config.js:ro \
  -v aegis-state:/var/lib/aegis \
  -v aegis-workspace:/workspace \
  -p 8080:8080 \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  -e GITHUB_TOKEN=$GITHUB_TOKEN \
  -e GITHUB_WEBHOOK_SECRET=$GITHUB_WEBHOOK_SECRET \
  -e SLACK_BOT_TOKEN=$SLACK_BOT_TOKEN \
  -e SLACK_APP_TOKEN=$SLACK_APP_TOKEN \
  -e METRICS_TOKEN=$(openssl rand -hex 32) \
  --restart=unless-stopped \
  aegis:0.1.0
```

Custom OpenAI-compatible provider (here Vultr, but the shape is the same for
OpenRouter, a self-hosted Ollama, or any other endpoint that speaks the
OpenAI Chat Completions wire format). The provider is declared in
`agent.customProviders` in your config, and the env var name comes from
that block's `apiKeyEnv` field:

```bash
docker run -d --name aegis \
  -v $PWD/aegis.config.js:/aegis/aegis.config.js:ro \
  -v aegis-state:/var/lib/aegis \
  -v aegis-workspace:/workspace \
  -p 8080:8080 \
  -e VULTR_API_KEY=$VULTR_API_KEY \
  -e GITHUB_TOKEN=$GITHUB_TOKEN \
  -e GITHUB_WEBHOOK_SECRET=$GITHUB_WEBHOOK_SECRET \
  -e SLACK_BOT_TOKEN=$SLACK_BOT_TOKEN \
  -e SLACK_APP_TOKEN=$SLACK_APP_TOKEN \
  -e METRICS_TOKEN=$(openssl rand -hex 32) \
  --restart=unless-stopped \
  aegis:0.1.0
```

Custom providers (any OpenAI-compatible endpoint - Vultr, OpenRouter, a local
Ollama) work the same way. Add them to `agent.customProviders` in your
config and pass the corresponding `apiKeyEnv` value to `docker run`.

A note on `http.bindAddr`: the example config uses `0.0.0.0`, which is what
makes the container reachable from the host port mapping. Setting it to
`127.0.0.1` will leave the container listening only on its loopback
interface, and the host port mapping will appear to do nothing.

## Image size and resource targets

The runtime image weighs roughly 750 MB at the time of writing. The .NET SDK
is the dominant cost (it has to be a real SDK, not the runtime-only base, so
that MSBuild can load Roslyn projects). If we add more SDK majors later (for
example .NET 8 or 9 alongside 10) the image will grow further. There is no
fixed compressed-size target.

- RAM: 1 GB baseline, plus roughly 50 MB per active worker, plus graph size
  (50-200 MB for a 20-repo fleet).
- CPU: idle under 5%. Under load: worker-bound (LLM calls are the slow path).
- Disk: `/workspace` is dominated by repo sizes. `/var/lib/aegis` stays
  small (under 100 MB typical, audit log rotates).

## TODOs - production hardening (post-MVP)

**Secret management (post-MVP):**
- Docker secrets: mount `/run/secrets/*` and read files instead of env
  vars. Adapter `ctx.secrets.get(key)` to transparently fall back:
  env var first, `/run/secrets/<key>` second.
- Kubernetes: project secrets as volumes; same fallback path works.
- Vault integration via the same `SecretsProvider` interface.

**Multi-arch CI smoke (post-MVP):**
- The Dockerfile already builds for both `linux-x64` and `linux-arm64`
  via `TARGETARCH`. The arm64 path is smoke-tested on Apple Silicon.
  The amd64 path needs a CI matrix run before we publish multi-arch
  manifests with confidence. See `GAPS.md` G-15.

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
