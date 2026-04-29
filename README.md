Aegis
=====

The shield of Zeus, in TypeScript form.
An autonomous AI code-review agent for .NET microservice fleets.

---

## The problem

The pull request queue never empties anymore. AI agents generate implementations in minutes and code review is supposed to happen the same afternoon. In practice it doesn't, not the kind that matters. The code compiles, the tests pass, and it ships.

What ships with it is harder to see. A missed CancellationToken that causes requests to hang under backpressure. A contract change in one service that quietly breaks two others whose teams find out three deploys later. A buffer with no bound that works fine in testing and falls over at 10x load. Not the kind of bugs static analysis catches. The kind that only appear when the whole system is moving.

In a microservice fleet, the blast radius of a change is rarely visible from the PR. The reviewer sees the diff. They don't see the eight downstream clients consuming the endpoint that just changed shape.

Existing review tools don't help much here. CodeRabbit, Sourcery and their peers are diff-only (they see what changed in this PR, not what it touches across the rest of your system). They cannot tell you which of your other fourteen services depend on the interface you just refactored. The best studies of these tools put their real-world bug detection rate around 46-48%.

Some engineers prefer quality over speed. They spend time thinking through designs, tracing dependencies, asking whether a change is actually correct before asking whether it compiles. That is the kind of review that catches what matters. Most teams don't have the bandwidth or the .NET depth to do it at scale. Aegis is an attempt to automate that standard and make it accessible, in the hope that more people will see it is worth caring about.

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
