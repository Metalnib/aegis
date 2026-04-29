Aegis
=====

The shield of Zeus, in TypeScript form.
An autonomous AI code-review agent for .NET microservice fleets.

---

The Problem
-----------

The pull request queue never empties anymore. AI agents generate implementations in minutes, the code compiles, tests pass, and it ships. The loop is not the hard part.

The hard part is the verifier. Not a test suite. The artifact that encodes what your system actually means by correct. In a microservice fleet, a field rename in one service can silently break three downstream consumers. A buffer with no bound works fine in testing and falls over at 10x load. A contract changes without a deprecation path, breaking every caller that hasn't recompiled. These are not the kinds of bugs static analysis catches. They are the kinds engineers catch, the ones who have spent years on these systems and carry the blast radius of a change in their heads before they write the first line.

That knowledge doesn't live in any tool. It lives in people. Company knowledge, system design intuition built over years. And when those people are reviewing a hundred AI-generated PRs a week, it doesn't transfer.

Aegis is a first step. It provides the infrastructure: a live cross-repo dependency graph, an LLM that reasons about real facts instead of guessing from diffs, and a skill system where domain rules can be encoded and applied to every PR automatically. The second step is engineers with taste and know-how, willing to bring what they know into it, in the hope that what they have learned doesn't have to be re-learned every time a team changes.

---

How it works
------------

Other tools look at the diff. Aegis looks at the system.

A sister project ([Synopsis](https://github.com/Metalnib/dotnet-episteme-skills/tree/main/src/synopsis)) parses every watched repository with Roslyn and builds a live cross-repo dependency graph: HTTP routes, EF Core entity mappings, NuGet symbols, message brokers, service-to-service call chains. When a PR opens, Aegis doesn't guess what the change touches. It asks the graph. The graph answers with classified facts (breaking-change kinds, certainty levels, affected callers across repositories), and hands those facts to the LLM.

The LLM reasons. The graph doesn't hallucinate.

Aegis watches pull requests across GitHub and GitLab (polling every 60s, webhook intake for instant reviews), runs the review against the diff plus live graph queries, then posts inline PR review comments, attaches a blast-radius report, and pings Slack or Google Chat on Critical and High findings.

It is also interactive. From Slack or Google Chat you can trigger ad-hoc reviews, query the graph directly (blast radius, call paths, endpoint callers, database lineage), manage watched repos at runtime, handle failed jobs in the queue, and swap the underlying LLM without restarting anything. Anthropic, OpenAI, Google, Mistral, anything the Pi Agent runtime supports, all switchable with one chat command.

---

Architecture in 30 seconds
---------------------------

```
PRs --+- poll ----> Queue (SQLite) ----> Agent worker pool ----> Synopsis (MCP/UDS)
      |                                       |                          |
      +- webhook                              +- Pi runtime + LLM        +- Roslyn graph
                                              (Anthropic / OpenAI /
                                               Google / Mistral / ...)
```

Pi Agent ([pi-mono][pi]) drives the LLM loop and tool execution. Synopsis talks to the agent over a Unix domain socket using the Model Context Protocol. Everything runs in a single Docker image with an embedded HTTP server (Prometheus metrics, healthz, read-only HTML dashboard), SQLite for state, no Redis, no sidecars.

---

Quick start (Docker)
--------------------

```bash
# 1. Build the image
./scripts/build-docker.sh

# 2. Copy and edit the example config
cp aegis.config.example.ts aegis.config.ts

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

# Dashboard:  http://localhost:8080/dashboard
# Metrics:    http://localhost:8080/metrics
# Webhooks:   http://localhost:8080/webhooks/github
```

For Kubernetes see [helm/aegis/](helm/aegis/README.md).

---

Repository layout
-----------------

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

Docs: [ARCHITECTURE.md](docs/ARCHITECTURE.md), [CONFIGURATION.md](docs/CONFIGURATION.md), [DEPLOYMENT.md](docs/DEPLOYMENT.md), [CHAT_COMMANDS.md](docs/CHAT_COMMANDS.md), [ROADMAP.md](docs/ROADMAP.md). Annotated config example in [aegis.config.example.ts](aegis.config.example.ts).

---

Aegis consumes [dotnet-episteme-skills][skills-repo] at build time. The Synopsis binary is compiled from that repo and bundled into the Docker image and the review skills are copied into the image at /opt/aegis/skills/. dotnet-episteme-skills stays standalone, usable from Claude Code or any other agent independently.

---

Aegis 1.0.0 is feature-complete. P0 through P3 (Synopsis integration, MVP, multi-host, production hardening) all shipped. P4 (more adapters, plugin template, public SDK) is next.

Aegis (Αιγις) is the shield of Zeus. Defensive framing: it guards the microservice fleet against breaking changes crossing repo boundaries.

---

Bonus track
-----------

Listening fuel for late-night refactors: [https://youtu.be/3uPXkcE-mC4](https://youtu.be/3uPXkcE-mC4)

---

License and attribution
-----------------------

Copyright (c) 2026 [Metalnib](https://github.com/Metalnib). Licensed under the [MIT License](LICENSE).

Built on top of [pi-mono][pi] by Mario Zechner (MIT), the [Model Context Protocol SDK][mcp] by Anthropic (MIT), [Roslyn][roslyn] and [MSBuild][msbuild] by the .NET Foundation (MIT), and [Node.js][node] by the OpenJS Foundation (MIT). Full attribution in [NOTICE](NOTICE).

[synopsis]: https://github.com/Metalnib/dotnet-episteme-skills/tree/main/src/synopsis
[skills]: https://github.com/Metalnib/dotnet-episteme-skills/tree/main/skills
[skills-repo]: https://github.com/Metalnib/dotnet-episteme-skills
[pi]: https://github.com/badlogic/pi-mono
[mcp]: https://modelcontextprotocol.io
[roslyn]: https://github.com/dotnet/roslyn
[msbuild]: https://github.com/dotnet/msbuild
[node]: https://nodejs.org
