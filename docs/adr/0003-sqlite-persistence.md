# ADR 0003 — SQLite for persistence

**Status:** Accepted

## Context

Aegis needs durable state:
- Queue of PR-review jobs.
- Adapter cursors (last-polled timestamps, seen-PR IDs).
- Audit log.
- Rate-limit counters.

Options: Redis, Postgres, embedded SQLite, plain JSON files.

## Decision

**SQLite** for all persistence, at `/var/lib/aegis/aegis.db`.

## Rationale

- Zero ops overhead, no separate service.
- WAL mode gives safe concurrent reads + a single writer — matches our
  one-worker-pool-with-queue model.
- Supports the durability requirements (crash safety, transactional
  enqueue-and-mark-done).
- Queue schema stays simple; no need for Redis streams or pub/sub.
- Storage footprint tiny (< 100 MB for typical loads).

## Consequences

- Single-writer: one Aegis process at a time writes to the DB. Horizontal
  scale (multiple Aegis instances) would require swapping to Postgres /
  Redis. The queue and KV interfaces abstract this so the swap is local.
- Backup = copy the DB file. Restore = replace the DB file.
- No fancy queue features (priority, delayed jobs, dead-letter auto-expiry)
  in MVP; implemented in SQL as needed.

## Schema sketch

```sql
CREATE TABLE jobs (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,            -- 'review', 'rescan', ...
  payload       BLOB NOT NULL,            -- JSON
  dedup_key     TEXT UNIQUE,              -- pr-ref + head-sha
  status        TEXT NOT NULL,            -- 'pending', 'running', 'done', 'failed', 'dlq'
  attempts      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  next_run_at   INTEGER
);

CREATE TABLE kv (
  namespace     TEXT NOT NULL,   -- adapter id
  key           TEXT NOT NULL,
  value         BLOB NOT NULL,
  PRIMARY KEY (namespace, key)
);

CREATE TABLE audit (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            INTEGER NOT NULL,
  actor         TEXT,
  action        TEXT,
  subject       TEXT,
  payload       BLOB
);
```

Refined during P1 implementation.
