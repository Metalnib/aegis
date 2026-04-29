# Configuration

Aegis is configured via a single TypeScript/JavaScript file (`aegis.config.ts`
in development, compiled to `aegis.config.js` for production). Using a real
module (not YAML) gives:

- Type-checking via `@aegis/sdk` types.
- Ability to compute values (env-var reads, conditional adapters).
- Direct imports of adapter factories.

## File shape

```ts
import { defineConfig } from "@aegis/core";
import { github } from "@aegis/adapter-github";
import { gitlab } from "@aegis/adapter-gitlab";
import { slack }  from "@aegis/adapter-slack";
import { gchat }  from "@aegis/adapter-gchat";

export default defineConfig({
  // Where repos are cloned inside the container.
  workspace: "/workspace",

  // Synopsis daemon connection. The supervisor spawns Synopsis as a child
  // process and connects via unix socket. Inside the Docker image the binary
  // and state-dir defaults are correct; override these for local dev.
  synopsis: {
    transport: "unix",
    path: "/var/run/aegis/synopsis.sock",
    // bin: "/path/to/synopsis",                  // local dev override
    // stateDir: "/var/lib/aegis/synopsis",       // default; override for local dev
  },

  // LLM agent.
  agent: {
    provider: "anthropic",                 // matches a customProviders key OR a built-in Pi provider
    model: "claude-opus-4-7",
    concurrency: 4,
    jobTimeoutSec: 600,
    providerLimits: {
      // Per-provider semaphore caps. Lower than `concurrency` for stricter rate-limited APIs.
      anthropic: { concurrency: 4 },
      vultr:     { concurrency: 8 },
    },
    // Custom OpenAI-compatible endpoints. Add as many as you want; each becomes
    // a switchable provider via chat (`/model <name> <model-id>`). Anything not
    // listed here falls through to Pi's built-in registry (anthropic, openai, ...).
    customProviders: {
      vultr: {
        baseUrl: "https://api.vultrinference.com/v1",
        apiKeyEnv: "VULTR_API_KEY",
        api: "openai-completions",
        contextWindow: 131072,
        maxTokens: 32768,
      },
      "local-ollama": {
        baseUrl: "http://localhost:11434/v1",
        contextWindow: 8192,
      },
    },
  },

  // Code host adapters (one or more).
  codeHosts: [
    github({
      host: "github.com",
      org: "myorg",
      repos: ["svc-a", "svc-b", "svc-c", "shared-lib"],
      pollIntervalSec: 60,
      tokenEnv: "GITHUB_TOKEN",
    }),
  ],

  // Chat adapters (zero or more).
  chats: [
    slack({
      channels: ["#aegis-alerts", "#aegis-ops"],
      notifyOn: ["Critical", "High"],
      socketMode: true,
      botTokenEnv: "SLACK_BOT_TOKEN",
      appTokenEnv: "SLACK_APP_TOKEN",
      permissions: {
        memberUsers:  ["UX1...", "UX2..."],
        adminUsers:   ["UX1..."],
      },
    }),
  ],

  // Which skills to load into the agent.
  skills: [
    "dotnet-techne-cross-repo-impact",
    "dotnet-techne-code-review",
    "dotnet-techne-crap-analysis",
    "dotnet-techne-synopsis",
  ],

  queue: {
    retries: 3,
    backoff: "exponential",
    dlqChannel: "#aegis-ops",
  },
  logging: {
    level: "info",
    format: "json",
  },
  http: {
    port: 8080,
    bindAddr: "0.0.0.0",
    metricsTokenEnv: "METRICS_TOKEN",
  },
});
```

## Configuration reload (what works without restart)

Aegis watches the config file and reapplies changes on the fly. Three triggers
are supported:

1. **File watch.** `fs.watchFile` polls the config path every 2 seconds. Edits
   from `kubectl edit configmap` or a mounted volume take effect within a few
   seconds (debounced 2.5s to absorb k8s atomic-swap double-events).
2. **SIGHUP.** `kill -HUP <pid>` (or `kubectl exec -- kill -HUP 1`) triggers an
   immediate reload.
3. **Chat command.** `@aegis reload` (admin-only) triggers a reload from chat.

Each reload is serialized (one at a time, never overlapping). The outcome is
logged, posted to the dashboard, and posted to the ops chat channel
(`queue.dlqChannel`) on failure or refusal.

### Reload tiers

Each field is classified by what kind of change it can absorb at runtime.

| Field | Tier | Hot-reloadable | Notes |
|---|---|---|---|
| `agent.provider` | 1 | Yes | New default applies to next job; in-flight jobs finish on the old model. |
| `agent.model` | 1 | Yes | Same as above. |
| `agent.concurrency` | 1 | Yes | New cap applies to next job; in-flight jobs hold their permit. |
| `agent.jobTimeoutSec` | 1 | Yes | Applies to next job. |
| `agent.providerLimits` | 1 | Yes | Per-provider semaphore caps regenerated. |
| `agent.customProviders` | 1 | Yes | Add/remove/modify providers freely. If a removed provider is the active one (via persisted override), the override is dropped, ops chat is notified, and Aegis falls back to `agent.provider/model`. |
| `skills` | 1 | Yes | New jobs see the new prompt; in-flight jobs keep the prompt they started with. |
| `logging.level` | 1 | Yes | Applies immediately to all new log lines. |
| `logging.format` | 3 | No | Format is captured at logger construction. |
| `queue.retries` | 1 | Yes | Read fresh on each tick. |
| `queue.backoff` | 1 | Yes | Read on each retry calculation. |
| `queue.dlqChannel` | 1 | Yes | Notifications use the latest channel name. |
| `codeHosts[*].repos` | 1 | Yes | Adds start polling on the next interval. Removes stop polling immediately and drop matching webhook events. **In-flight jobs run to completion.** Pending queued jobs for removed repos are not cancelled (they will retry until the queue retry budget is exhausted, then DLQ). |
| `codeHosts[*].pollIntervalSec` | 1 | Yes | Applies to the next scheduled poll cycle. |
| `codeHosts[*].host` | 3 | No | Changes the API endpoint and Octokit instance. |
| `codeHosts[*].org` / `group` | 3 | No | Different scope; would re-scope every API call. |
| `codeHosts[*].tokenEnv` | 3 | No | Auth identity. |
| `codeHosts[*].webhookSecretEnv` | 3 | No | Webhook secret captured at init. |
| `codeHosts[*].webhookPath` | 3 | No | Webhook routes registered with HttpServer at startup. |
| Adapter add/remove (`codeHosts[]` length change) | 3 | No | New instances need init() with secrets and store. |
| `chats[*].channels` | 1 | Yes | Notifications use the latest channels. |
| `chats[*].notifyOn` | 1 | Yes | Severity filter applied next event. |
| `chats[*].permissions` | 1 | Yes | Applies to next command. |
| `chats[*].socketMode` / `*TokenEnv` / `signingSecretEnv` | 3 | No | Slack App connection captured at init. |
| `chats[*].spaces` (gchat) | 3 | No | Webhook URLs captured at init from secrets. |
| `http.port` / `http.bindAddr` | 3 | No | Socket binding. |
| `http.metricsTokenEnv` | 3 | No | Bearer token captured at HttpServer construction. |
| `workspace` | 3 | No | Filesystem identity for cloned repos. |
| `dbPath` | 3 | No | SQLite handle. |
| `synopsis.path` / `synopsis.transport` | 3 | No | Daemon connection. |
| `skillsDir` / `soulPath` | 3 | No | Captured at SkillLoader construction. |

When a Tier 3 field changes, the reload is **refused as a whole** and the
previous config keeps running. The dashboard shows a yellow "Restart required"
banner with the affected fields. The ops chat channel gets a one-line notice.
The operator restarts when ready - no work is lost (queue is durable).

When a reload **fails validation** (Zod schema rejects the new file), the
previous config keeps running. The error is logged and posted to ops chat.

### What does NOT survive reload

A pre-existing model override saved via `@aegis model <vultr> ...` will be
**dropped** if the next config no longer defines a `vultr` customProvider.
The dashboard shows the active model; ops chat gets a notice.

### Tier 3 will be supported later

Adding/removing whole adapters and changing process-bound resources (port,
dbPath, etc.) is out of scope for the current release. Restart is the
documented path. See ADR `0015-config-hot-reload.md`.

## Validation

At startup and on every reload, `@aegis/core`:

1. Loads the file via Node's `require` cache (cleared between reloads).
2. Parses into a Zod schema.
3. Fails-fast with precise error messages on invalid config.

CLI:

```
aegis config validate [aegis.config.js]
```

## Default values

| Key | Default |
|---|---|
| `workspace` | `/workspace` |
| `synopsis.transport` | `unix` |
| `synopsis.path` | `/var/run/aegis/synopsis.sock` |
| `synopsis.bin` | `/opt/aegis/bin/synopsis` (or `$SYNOPSIS_BIN` env var) |
| `synopsis.stateDir` | `/var/lib/aegis/synopsis` |
| `agent.provider` | `anthropic` |
| `agent.model` | `claude-opus-4-7` |
| `agent.concurrency` | `4` |
| `agent.jobTimeoutSec` | `600` |
| `agent.customProviders` | `{}` |
| `queue.retries` | `3` |
| `queue.backoff` | `exponential` |
| `logging.level` | `info` |
| `logging.format` | `json` |

## Custom providers (OpenAI-compatible endpoints)

Anything that speaks the OpenAI Chat Completions wire format can be plugged in:
Vultr, OpenRouter, local Ollama, an enterprise Azure OpenAI proxy, etc.

```ts
agent: {
  provider: "vultr",                       // make Vultr the default
  model: "llama-3.3-70b-instruct-fp8",
  customProviders: {
    vultr: {
      baseUrl: "https://api.vultrinference.com/v1",
      apiKeyEnv: "VULTR_API_KEY",
      api: "openai-completions",           // default; alternatives: openai-responses, anthropic-messages, ...
      reasoning: false,                     // set true if the model exposes reasoning tokens
      vision: false,                        // set true for multimodal input
      contextWindow: 131072,
      maxTokens: 32768,
    },
  },
}
```

Switching at runtime via chat:

```
@aegis providers
@aegis model vultr llama-3.1-405b-instruct
@aegis model anthropic claude-opus-4-7
@aegis model reset
```

The override persists in SQLite. On reload of a config that no longer defines
the active custom provider, the override is dropped (see "What does NOT
survive reload" above).

## Multiple instances of the same adapter

Supported - each instance needs a unique `id`:

```ts
codeHosts: [
  github({ id: "gh-corp", host: "github.com", org: "corp", repos: [...] }),
  github({ id: "gh-enterprise", host: "ghe.internal", org: "platform", repos: [...], tokenEnv: "GHE_TOKEN" }),
],
```

Events from each carry the adapter `id`. The reload diff matches by `id`, so
renaming an adapter (`id` change) is treated as remove + add, which is Tier 3.

## Configuration file location

- Dev: `./aegis.config.ts` at repo root.
- Docker: pass the path as the first argument: `aegis serve /opt/aegis/aegis.config.js`.
  The Helm chart mounts the ConfigMap at `/opt/aegis/aegis.config.js` by default.
  Mount the **compiled** file so the container doesn't need a TS loader.

## Secrets

See [DEPLOYMENT.md](DEPLOYMENT.md) for the env-var contract. The `EnvSecrets`
provider supports both direct env vars and the 12-factor `${KEY}_FILE`
indirection used by Docker secrets and k8s file-mounted secrets.

> Caveat: file-mounted secrets are cached per-process. Rotating a secret
> requires a pod restart even though the config supports hot reload. Aegis logs
> a one-time notice the first time a `_FILE` secret is read.

## Adapter-specific options

See each adapter's README. Common shape:

```ts
interface CommonAdapterOptions {
  id?: string;              // override default id
}
```
