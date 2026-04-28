# Repo Layout

Aegis is a TypeScript monorepo, **forked from Pi** (`badlogic/pi-mono`) and
heavily extended.

## Directory tree

```
aegis/
├── packages/
│   ├── core/                    # event bus, queue, supervisor, git-sync, config
│   ├── agent/                   # Pi-based LLM worker, skill loader, MCP client
│   ├── sdk/                     # public types, CodeHostAdapter, ChatAdapter
│   ├── adapter-github/          # MVP
│   ├── adapter-gitlab/          # MVP
│   ├── adapter-slack/           # MVP
│   ├── adapter-gchat/           # MVP
│   └── cli/                     # `aegis serve`, `aegis config validate`
│
├── docker/
│   ├── Dockerfile               # single multi-stage image
│   ├── entrypoint.sh            # starts synopsis + aegis with supervision
│   └── healthcheck.sh
│
├── scripts/
│   ├── link-skills.sh           # dev: symlinks sibling episteme-skills
│   ├── build-synopsis.sh        # dev: builds Synopsis linux-x64 locally
│   └── test-e2e.sh
│
├── skills/                      # gitignored — populated by link-skills.sh
│                                # or copied from episteme-skills in Docker build
│
├── docs/                        # this folder
│   └── adr/                     # architecture decision records
│
├── SOUL.md                      # Aegis identity — injected as agent system prompt
├── aegis.config.example.ts
├── package.json                 # pnpm workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── README.md
```

**Note on SOUL.md.** This file is the agent's identity (who Aegis is, its
defensive stance, its severity philosophy). It is loaded as a **context
file** by `@aegis/agent` at session init, not as a skill. See
[ARCHITECTURE.md § Prompt layering](ARCHITECTURE.md#prompt-layering) for
why the soul is separate from skills.

SOUL.md lives **in the Aegis repo**, not in episteme-skills, because it
describes Aegis specifically — it is not a reusable procedure. In the
Docker image it lands at `/opt/aegis/SOUL.md`.

## Pi fork strategy

Pi is forked once into `aegis/`. The fork stays in a single repo; we do not
maintain separate upstream-tracking branches. Rationale:

- We expect deep changes to Pi's agent runtime, skill loader, and tool-call
  execution — enough that staying in lockstep with upstream is more cost than
  benefit.
- Upstream security patches are pulled manually by occasional merge or
  cherry-pick; we track `pi-mono` releases in a changelog.

**What we keep from Pi (initially):**
- LLM provider abstraction (multi-provider is useful for future flexibility).
- Skill discovery and SKILL.md parsing.
- Tool-call execution loop.
- Terminal UI code (for local `aegis serve --interactive` mode).

**What we replace:**
- CLI entry point → `@aegis/cli`.
- Session storage → SQLite via `@aegis/core`.
- Tool registry → extended with MCP client + adapter-sourced tools.

**What we add:**
- Everything in `core`, `sdk`, all adapters, the supervisor / git-sync / queue.

## Relationship to `dotnet-episteme-skills`

Two repos, kept independent:

```
/Users/hgg/work/dotnet-skills/
├── aegis/                      # this repo
└── dotnet-episteme-skills/     # separate repo (standalone)
```

**How Aegis consumes episteme-skills:**

| Asset | Where in episteme-skills | How Aegis uses it |
|---|---|---|
| Synopsis binary | `src/synopsis/` → `dotnet publish` | Built in Docker build stage; copied into final image at `/opt/aegis/bin/synopsis` |
| `dotnet-techne-*` skills | `skills/dotnet-techne-*/` | Copied into image at `/opt/aegis/skills/<skill-name>/` |
| Cross-repo impact skill | Authored in episteme-skills: `skills/dotnet-techne-cross-repo-impact/` | Same — copied into image. Procedural only; the matching identity lives in Aegis's `SOUL.md`. |

Aegis's `SOUL.md` is **not** sourced from episteme-skills — it is
Aegis-specific identity and stays in this repo.

**Development workflow (local, no Docker):**

```bash
# one-time: check out both repos as siblings
cd ~/work/dotnet-skills
git clone ...aegis
git clone ...dotnet-episteme-skills

# in aegis/
./scripts/link-skills.sh         # symlinks ../dotnet-episteme-skills/skills → ./skills
./scripts/build-synopsis.sh      # builds Synopsis, puts binary in ./bin/synopsis
pnpm install
pnpm dev                         # runs aegis against local /workspace
```

**Rules of the split:**

1. `dotnet-episteme-skills` **never** imports from `aegis`. It stays usable
   standalone by Claude Code, other agents, or humans.
2. `aegis` treats episteme-skills as a **build-time artifact source**, not
   a code dependency. No cross-repo `import` statements in either direction.
3. The `dotnet-techne-cross-repo-impact` skill is authored in
   episteme-skills (so it's reusable by Claude Code and other agents),
   even though Aegis is its primary user. The skill is purely procedural
   — identity lives in Aegis's `SOUL.md`.
4. Breaking changes to Synopsis MCP tools require coordination: bump the
   Synopsis version in episteme-skills, then update Aegis's MCP client.
   Aegis pins a specific Synopsis version in its Docker build.
5. If a skill's procedural contract shifts (e.g. new MCP tool in the
   recipe), update it in episteme-skills and re-pin. If Aegis's identity
   or severity philosophy shifts, update `SOUL.md` in this repo only.

## Package dependencies

```
core ──▶ sdk
agent ──▶ sdk
adapter-github ──▶ sdk
adapter-gitlab ──▶ sdk
adapter-slack  ──▶ sdk
adapter-gchat  ──▶ sdk
cli    ──▶ core, agent, adapter-*
```

`sdk` has **zero** runtime dependencies beyond TypeScript types. Adapters stay
lightweight and don't pull the core event-bus code.

## Versioning

- Monorepo versioned together via changesets.
- Public API surface is `@aegis/sdk`; bump major when SPI changes.
- Synopsis is versioned in episteme-skills; pinned per Aegis release.
