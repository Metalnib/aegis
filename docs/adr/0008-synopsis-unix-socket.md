# ADR 0008 — Synopsis talks over Unix socket (inside the image)

**Status:** Accepted

## Context

Synopsis exposes MCP. In a single-image deployment, Aegis and Synopsis
share the container's filesystem and process namespace. Transports
considered: stdio (current Synopsis behaviour), Unix domain socket,
TCP localhost, named pipe.

## Decision

**Unix socket** at `/var/run/aegis/synopsis.sock` for single-image
deployments. TCP available as an alternative (for hypothetical future
multi-container setups) but not used in MVP.

## Rationale

- Unix sockets are cheaper than TCP locally (no kernel network stack).
- Permissions are filesystem-scoped; no accidental port exposure.
- No port allocation bookkeeping.
- Multi-client by design (the M1 transport work makes the server accept
  concurrent connections).
- TCP remains a first-class transport in Synopsis — if users split the
  deployment later, no Synopsis change is needed.

## Consequences

- Synopsis M1 gains `--socket <path>` alongside `--tcp <addr>`.
- Aegis supervisor ensures the socket directory exists, and cleans stale
  sockets on startup.
- Health check: a tiny MCP `ping` roundtrip on the socket.
- Documentation clearly states: for multi-container deployments, switch to
  `--tcp` and expose the port.

## Alternatives rejected

- **Stdio only (current behaviour).** Rejected — stdio is one-client and
  ties Synopsis to a parent process's lifetime, which doesn't match the
  daemon model.
- **TCP localhost only.** Works, but exposes a port for no reason in the
  single-image case and is marginally slower.
- **Named pipes.** Windows-friendly but we target Linux for the Docker
  image.
