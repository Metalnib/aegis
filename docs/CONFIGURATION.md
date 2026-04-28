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

  // Synopsis daemon connection (inside the single image, a unix socket).
  synopsis: {
    transport: "unix",
    path: "/var/run/aegis/synopsis.sock",
  },

  // LLM agent.
  agent: {
    provider: "anthropic",
    model: "claude-opus-4-7",
    concurrency: 4,
    // Timeout for a single PR review end-to-end.
    jobTimeoutSec: 600,
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
  // Order is significant: soul skill runs first.
  skills: [
    "dotnet-techne-cross-repo-impact",
    "dotnet-techne-code-review",
    "dotnet-techne-crap-analysis",
    "dotnet-techne-synopsis",
  ],

  // Advanced (all optional).
  queue: {
    retries: 3,
    backoff: "exponential",
    dlqChannel: "#aegis-ops",
  },
  logging: {
    level: "info",
    format: "json",
  },
});
```

## Validation

At startup, `@aegis/core`:

1. Loads the file via a TS loader (tsx / esbuild).
2. Parses into a Zod schema.
3. Fails-fast with precise error messages on invalid config.
4. Verifies every referenced env var is present (empty string → fail).
5. Verifies every skill name corresponds to a skill in
   `/opt/aegis/skills/`.
6. Smoke-tests adapter init (dry-run), so an expired token surfaces at
   boot, not at first event.

CLI:

```
aegis config validate [--file /etc/aegis/aegis.config.js]
```

## Default values

| Key | Default |
|---|---|
| `workspace` | `/workspace` |
| `synopsis.transport` | `unix` |
| `synopsis.path` | `/var/run/aegis/synopsis.sock` |
| `agent.provider` | `anthropic` |
| `agent.model` | `claude-opus-4-7` |
| `agent.concurrency` | `4` |
| `agent.jobTimeoutSec` | `600` |
| `queue.retries` | `3` |
| `queue.backoff` | `exponential` |
| `logging.level` | `info` |
| `logging.format` | `json` |

## Adapter-specific options

See each adapter's README. Common shape:

```ts
interface CommonAdapterOptions {
  id?: string;              // override default id (useful for multiple GitHub orgs)
  // Any secrets are specified as env var names, not values.
  // e.g. tokenEnv: "GITHUB_TOKEN" not token: process.env.GITHUB_TOKEN
}
```

## Hot reload

Not supported in MVP. Config changes require a container restart.

Rationale: simplicity + SQLite state continuity. A stop-the-world reload
in a single-container deployment is fine; the queue is durable, so in-flight
jobs resume automatically.

## Multiple instances of the same adapter

Supported — each instance needs a unique `id`:

```ts
codeHosts: [
  github({ id: "gh-corp", host: "github.com", org: "corp", repos: [...] }),
  github({ id: "gh-enterprise", host: "ghe.internal", org: "platform", repos: [...], tokenEnv: "GHE_TOKEN" }),
],
```

Events from each carry the adapter `id`, so reviews always round-trip to
the same host.

## Configuration file location

- Dev: `./aegis.config.ts` at repo root.
- Docker: `AEGIS_CONFIG` env var points to a mounted JS file
  (default `/etc/aegis/aegis.config.js`). Mount the **compiled** file so
  the container doesn't need a TS loader.

## Secrets

See [DEPLOYMENT.md](DEPLOYMENT.md#environment-variables-mvp) for the env-var
contract. MVP is env-var-based; post-MVP adds Docker secrets / k8s secrets
via the same `SecretsProvider` interface. No changes to `aegis.config.ts`
are needed — `tokenEnv: "GITHUB_TOKEN"` still reads from wherever the
provider looks.

## Config versioning

The top-level `defineConfig` result carries an implicit version. When we
introduce a breaking config change, `defineConfig` will gain a
`schemaVersion` field, and Aegis will print a migration hint on startup.
