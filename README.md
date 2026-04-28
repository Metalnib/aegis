# Aegis

> The shield of Zeus, in TypeScript form.
> An autonomous AI code-review agent for .NET microservice fleets.

Aegis watches your pull requests across many repositories, reviews them
with LLMs that can actually reason about your codebase, and tells you
when a "small" change in one service is about to silently break three
others.

## Why this project exists

Modern .NET shops live in microservice fleets. A field rename in one
repo travels through HTTP clients, EF Core projections, and integration
tests across half-a-dozen others - and the PR author can't see any of
it from their local checkout.

Code reviewers can't either. Static analyzers stop at the project
boundary. LLM-only review tools see one diff and hallucinate the rest.

Aegis takes a different shape:

- **A real graph, not a vibe.** A sister project, [Synopsis][synopsis],
  parses every watched repo with Roslyn and builds a typed cross-repo
  dependency graph: HTTP routes, EF entities, NuGet symbols. Aegis
  hands the LLM **classified facts** (breaking-change kinds, certainty
  levels) rather than raw code and crossed fingers.
- **The LLM reasons, the graph doesn't.** Synopsis says *what changed
  and what depends on it.* The agent decides *whether it matters and
  what to recommend.* Hallucinations have nowhere to land - the facts
  are in the graph.
- **Autonomous, not advisory.** When a PR opens, Aegis reviews it
  within seconds (webhooks) or a minute (polling fallback), posts
  inline review comments on the PR, attaches a
  `cross-repo-impact.md` report, and pings Slack / Google Chat on
  Critical / High severity.
- **Operable.** Single Docker image. Embedded HTTP server with a
  Prometheus `/metrics` endpoint, `/healthz`, and a read-only HTML
  dashboard. Helm chart for k8s. SQLite for state - no Redis, no
  sidecars.

## What it does

- **Polls and webhooks.** GitHub and GitLab adapters poll every 60s
  and also accept webhooks (HMAC-SHA256 / token-verified) for instant
  intake.
- **Reviews each PR with skills.** The agent loads
  [`dotnet-techne-*` skills][skills] - cross-repo impact, code
  review, CRAP analysis, Synopsis querying - runs the review against
  the diff plus live MCP queries against Synopsis, and produces a
  structured finding list with severity.
- **Posts results back.** Inline PR review (`REQUEST_CHANGES` on
  Critical / High; `COMMENT` otherwise). Markdown blast-radius report
  as a separate PR comment. Slack / Google Chat notifications on
  Critical / High.
- **Is interactive.** Bot commands from chat:
  - `review <pr-url>` ad-hoc review
  - `impact <symbol>` / `callers <symbol>` / `paths <a> <b>` Synopsis queries
  - `endpoints` / `db <entity>` / `ambiguous` graph queries
  - `repos` / `watch <repo>` / `unwatch <repo>` runtime monitoring
  - `dlq` / `requeue <id>` / `cancel <id>` queue ops
  - `model` / `providers` / `model <provider> <id>` swap LLMs at runtime
  - `status` / `rescan <repo>` operational

## Architecture in 30 seconds

```
PRs --+- poll ----> Queue (SQLite) ----> Agent worker pool ----> Synopsis (MCP/UDS)
      |                                       |                          |
      +- webhook                              +- Pi runtime + LLM        +- Roslyn graph
                                              (Anthropic / OpenAI /
                                               Google / Mistral / ...)
```

- **Pi Agent** ([pi-mono][pi]) drives the LLM loop and tool execution.
- **MCP** ([Model Context Protocol][mcp]) talks to Synopsis over a
  Unix domain socket. Synopsis exposes 9 tools (impact, paths,
  endpoints, reindex, etc.) discovered dynamically.
- **Multi-provider.** Anthropic, OpenAI, Google, Mistral, anything
  Pi-supported. Switchable at runtime via chat; per-provider
  concurrency caps; adaptive 429 backoff so rate-limited jobs defer
  without burning retries.

## Quick start (Docker)

```bash
# 1. Build the image (uses dotnet-episteme-skills as build context)
./scripts/build-docker.sh

# 2. Edit aegis.config.example.ts -> aegis.config.ts (org, repos, secrets)

# 3. Run
docker run -d --name aegis \
  -v $PWD/aegis.config.ts:/opt/aegis/aegis.config.js \
  -v aegis-state:/var/lib/aegis \
  -v aegis-workspace:/workspace \
  -p 8080:8080 \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  -e GITHUB_TOKEN=$GITHUB_TOKEN \
  -e GITHUB_WEBHOOK_SECRET=$GITHUB_WEBHOOK_SECRET \
  -e SLACK_BOT_TOKEN=$SLACK_BOT_TOKEN \
  -e SLACK_APP_TOKEN=$SLACK_APP_TOKEN \
  aegis:0.1.0

# 4. Visit http://localhost:8080 for the dashboard
#    /metrics for Prometheus
#    /webhooks/github for GitHub webhook intake
```

For Kubernetes, see [`helm/aegis/`](helm/aegis/README.md).

## Repository layout

```
packages/
  sdk/             Adapter SPI, types, contracts
  core/            Queue, bus, supervisor, http server, metrics, git-sync
  agent/           Pi runtime, MCP client, skill loader, model resolver
  cli/             The serve command, command router, bin/aegis
  adapter-github/
  adapter-gitlab/
  adapter-slack/
  adapter-gchat/

helm/aegis/        k8s deployment chart
docker/            Multi-stage Dockerfile, entrypoint, healthcheck
docs/              Architecture, ADRs, deployment, configuration, roadmap
scripts/           build, test-e2e
```

## Docs

| Doc | What's in it |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, diagram, event flow |
| [CONFIGURATION.md](docs/CONFIGURATION.md) | `aegis.config.ts` schema |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | Single-image Docker + Helm |
| [CHAT_COMMANDS.md](docs/CHAT_COMMANDS.md) | Bot command catalog |
| [adapters.md](docs/adapters.md) | Adapter SPI and writing your own |
| [SKILL_CROSS_REPO_IMPACT.md](docs/SKILL_CROSS_REPO_IMPACT.md) | Soul skill spec |
| [ROADMAP.md](docs/ROADMAP.md) | Phased delivery, what shipped |
| [DECISIONS.md](docs/DECISIONS.md) + [adr/](docs/adr/) | Architecture decision records |
| [aegis.config.example.ts](aegis.config.example.ts) | Annotated sample config |

## Relationship to dotnet-episteme-skills

Aegis **consumes** [`dotnet-episteme-skills`][skills-repo] at build
time:

- **Synopsis binary** is built from
  `dotnet-episteme-skills/src/synopsis` and bundled into the Aegis
  Docker image.
- **Review skills** (`dotnet-techne-*` directories) are copied into
  the image at `/opt/aegis/skills/`.

`dotnet-episteme-skills` stays **standalone** - usable from Claude
Code, manual workflows, or other agents. Aegis is the consumer, not a
dependency.

## Status

Aegis 1.0.0 is feature-complete. P0 (Synopsis upgrade) + P1 (MVP) +
P2 (multi-host) + P3 (production hardening) all shipped. See
[ROADMAP.md](docs/ROADMAP.md) for the breakdown. P4 (ecosystem - more
adapters, plugin template, public SDK on npm) is next.

## Name

Aegis (Αἰγίς) - the shield of Zeus. Defensive framing: Aegis guards
the microservice fleet against breaking changes crossing repo
boundaries.

---

## Bonus track

Listening fuel for late-night refactors:
[https://youtu.be/3uPXkcE-mC4](https://youtu.be/3uPXkcE-mC4)

---

## License & attribution

Copyright (c) 2026 [Metalnib](https://github.com/Metalnib). Licensed
under the [MIT License](LICENSE).

Built on top of:

- **[pi-mono][pi]** by Mario Zechner - TypeScript agent runtime (MIT).
- **[Model Context Protocol SDK][mcp]** by Anthropic (MIT).
- **[Roslyn][roslyn]**, **[MSBuild][msbuild]** by the .NET Foundation (MIT).
- **[Node.js][node]** by the OpenJS Foundation (MIT).

Full attribution and forked-file conventions in [NOTICE](NOTICE).

[synopsis]: https://github.com/Metalnib/dotnet-episteme-skills/tree/main/src/synopsis
[skills]: https://github.com/Metalnib/dotnet-episteme-skills/tree/main/skills
[skills-repo]: https://github.com/Metalnib/dotnet-episteme-skills
[pi]: https://github.com/badlogic/pi-mono
[mcp]: https://modelcontextprotocol.io
[roslyn]: https://github.com/dotnet/roslyn
[msbuild]: https://github.com/dotnet/msbuild
[node]: https://nodejs.org
