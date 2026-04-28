# ADR 0004 — Use Pi as npm packages, not a fork

**Status:** Accepted (supersedes the earlier "fork Pi" decision)

## Context

Pi (`@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`) is a TS agent
runtime with LLM provider abstraction, tool-call execution, and streaming.
The original plan was to fork the repo and modify it freely. That was
reconsidered once we inspected the actual extension surface.

## Decision

**Depend on Pi via npm.** Add `@mariozechner/pi-agent-core` and
`@mariozechner/pi-ai` as regular workspace dependencies.

## Rationale

- The `Agent` class accepts `AgentTool<TParameters>` objects at construction
  time. Every capability Aegis needs - MCP bridging, gh CLI, custom tools -
  can be expressed as tools without touching Pi internals.
- Pi's `getModel(provider, modelId)` already covers every provider we need
  (Anthropic, OpenAI, Google, Mistral, Bedrock). A fork would carry that
  table as dead weight.
- Pi's providers auto-register when `@mariozechner/pi-ai` is imported.
  No config, no init call.
- Upstream gets security fixes for free via `pnpm update`.
- OpenClaw forked Pi because it needed to patch the session store and the
  Codex streaming quirks. Aegis does not.

## Consequences

- Aegis is bound to Pi's public API. Breaking changes in a Pi minor
  release require a workspace dep update and a one-line fix at most.
- MCP tool bridging (`synopsis-mcp.ts`) casts `inputSchema as unknown as TSchema`
  because Pi uses typebox and MCP uses JSON Schema. This is a known
  approximation - both are serialized to the same JSON for the LLM.
- If Pi ever drops a provider we need (unlikely), we can vendor just that
  provider file without forking the whole package.

## Alternatives rejected

- **Fork Pi.** Rejected - the changes we need are expressible through the
  public tool API. A fork adds maintenance cost with no benefit.
- **Build from scratch without Pi.** Rejected - Pi's LLM provider
  abstraction and tool-call loop save meaningful work.
