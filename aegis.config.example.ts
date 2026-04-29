// Annotated sample Aegis configuration.
// Copy to aegis.config.ts, fill in real org/repo names, set env vars, run.
//
// See docs/CONFIGURATION.md for the full schema.

import { defineConfig } from "@aegis/core";
import { github } from "@aegis/adapter-github";
import { gitlab } from "@aegis/adapter-gitlab";
import { slack }  from "@aegis/adapter-slack";
import { gchat }  from "@aegis/adapter-gchat";

export default defineConfig({
  // Where repos are cloned inside the container. Mount this as a volume.
  workspace: "/workspace",

  // Synopsis daemon connection.
  // Single-image deployment: use a unix socket. Multi-container: use tcp.
  synopsis: {
    transport: "unix",
    path: "/var/run/aegis/synopsis.sock",
  },

  // LLM agent settings. provider/model must be a valid Pi combination.
  // See: https://github.com/badlogic/pi-mono for the full model list.
  agent: {
    provider: "anthropic",       // "anthropic" | "openai" | ... or any key from customProviders
    model:    "claude-opus-4-7",
    concurrency: 4,
    jobTimeoutSec: 600,
    // Per-provider concurrency caps. Lower than `concurrency` for stricter rate-limited APIs.
    providerLimits: {
      // anthropic: { concurrency: 2 },
    },
    // OpenAI-compatible custom providers. Each key becomes a switchable provider
    // via chat (`/model <name> <model-id>`). Anything not listed here falls
    // through to Pi's built-in registry.
    customProviders: {
      // vultr: {
      //   baseUrl: "https://api.vultrinference.com/v1",
      //   apiKeyEnv: "VULTR_API_KEY",
      //   contextWindow: 131072,
      // },
      // "local-ollama": {
      //   baseUrl: "http://localhost:11434/v1",
      //   contextWindow: 8192,
      // },
    },
  },

  // Optional embedded HTTP server for webhook intake and Prometheus metrics.
  // Omit this block to run polling-only without any inbound HTTP listener.
  http: {
    port: 8080,
    bindAddr: "0.0.0.0",
    // metricsTokenEnv: "METRICS_TOKEN", // require Bearer auth on /metrics
  },

  // Code host adapters. Add one per GitHub org or GHE instance.
  codeHosts: [
    github({
      host: "github.com",         // or your GHE hostname
      org:  "myorg",
      repos: ["svc-a", "svc-b", "svc-c", "shared-lib"],
      pollIntervalSec: 60,
      tokenEnv: "GITHUB_TOKEN",
      // Webhook intake. Configure the GitHub webhook to POST to
      // https://<aegis-host>/webhooks/github with this secret.
      webhookSecretEnv: "GITHUB_WEBHOOK_SECRET",
    }),

    // Second GitHub instance (self-hosted Enterprise):
    // github({
    //   id: "gh-enterprise",
    //   host: "ghe.internal.corp",
    //   org: "platform",
    //   repos: ["gateway", "auth"],
    //   tokenEnv: "GHE_TOKEN",
    // }),

    // GitLab:
    // gitlab({
    //   host: "gitlab.com",
    //   group: "mygroup",
    //   repos: ["svc-d", "svc-e"],
    //   tokenEnv: "GITLAB_TOKEN",
    //   // Webhook posts to /webhooks/gitlab with X-Gitlab-Token = <secret>.
    //   webhookSecretEnv: "GITLAB_WEBHOOK_SECRET",
    // }),
  ],

  // Chat adapters. Zero or more.
  chats: [
    slack({
      channels: ["#aegis-alerts", "#aegis-ops"],
      notifyOn: ["Critical", "High"],
      socketMode: true,            // no public URL needed with Socket Mode
      botTokenEnv: "SLACK_BOT_TOKEN",
      appTokenEnv: "SLACK_APP_TOKEN",
      permissions: {
        memberUsers: ["U01ABCDEF", "U01GHIJKL"],
        adminUsers:  ["U01ABCDEF"],
      },
    }),

    // Google Chat (notification-only via incoming webhooks):
    // gchat({
    //   spaces: [{ id: "spaces/AAABBB", webhookUrlEnv: "GCHAT_WEBHOOK_AAABBB" }],
    //   notifyOn: ["Critical"],
    // }),
  ],

  // Skills loaded into the agent.
  // Order matters - cross-repo-impact should be first.
  skills: [
    "dotnet-techne-cross-repo-impact",
    "dotnet-techne-code-review",
    "dotnet-techne-crap-analysis",
    "dotnet-techne-synopsis",
  ],

  // Queue / retry policy.
  queue: {
    retries: 3,
    backoff: "exponential",
    dlqChannel: "#aegis-ops",
  },

  // Logging.
  logging: {
    level: "info",
    format: "json",
  },
});
