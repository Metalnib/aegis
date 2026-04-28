# ADR 0007 — Two adapter surfaces

**Status:** Accepted

## Context

Aegis integrates with heterogeneous systems: code hosts (GitHub, GitLab,
Bitbucket, Azure DevOps) and chat platforms (Slack, Google Chat, Discord,
Teams). A naive design has one `Adapter` interface covering both. A more
decomposed design has two.

## Decision

Two separate SPIs in `@aegis/sdk`:

- **`CodeHostAdapter`** — PR/MR lifecycle, diff fetch, review posting,
  open-PR search.
- **`ChatAdapter`** — command intake, replies, broadcast notifications.

## Rationale

- Code hosts and chat platforms have **different semantics**. Merging them
  into one interface forces stub methods on both sides (a chat platform
  has no `fetchDiff`; a code host has no `onCommand`).
- The separation clarifies testing contracts: code-host tests hit a mock
  Git API; chat tests hit a mock socket / webhook.
- Some platforms (Slack, Discord) might one day also be notification
  surfaces for code events *and* command channels for Aegis — with the
  split, that's two capabilities on one provider, not a schema weakened to
  accommodate a rare case.

## Consequences

- A hypothetical "unified" adapter (e.g. GitLab with built-in chat) ships
  as two packages sharing a repo and client.
- Core has two registries: `codeHosts[]` and `chats[]` in config.
- The event-bus schema stays cleaner: PR events and chat commands are
  distinct types.

## Alternatives rejected

- **Single `Adapter` with optional capability methods.** Rejected — too
  many stubs, testing contracts muddled.
- **`EventSource` + `EventSink` decomposition.** Tempting for elegance,
  but practitioners think in "GitHub adapter" and "Slack adapter"; naming
  should match the mental model.
