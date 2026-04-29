import Database from "better-sqlite3";
import type { PrRef, ReviewJob } from "@aegis/sdk";
import crypto from "node:crypto";

export class Queue {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS review_jobs (
        id          TEXT PRIMARY KEY,
        dedup_key   TEXT NOT NULL UNIQUE,
        host        TEXT NOT NULL,
        owner       TEXT NOT NULL,
        repo        TEXT NOT NULL,
        pr_number   INTEGER NOT NULL,
        head_sha    TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'pending',
        attempts    INTEGER NOT NULL DEFAULT 0,
        defers      INTEGER NOT NULL DEFAULT 0,
        enqueued_at TEXT NOT NULL,
        claimed_at  TEXT,
        done_at     TEXT,
        not_before  TEXT,
        error       TEXT
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id      TEXT NOT NULL,
        event       TEXT NOT NULL,
        detail      TEXT,
        ts          TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS kv (
        ns    TEXT NOT NULL,
        key   TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (ns, key)
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_pending
        ON review_jobs(status, not_before)
        WHERE status = 'pending';
    `);

    // Forward-compat: add columns to pre-existing DBs. SQLite has no IF NOT EXISTS for columns.
    try { this.db.exec(`ALTER TABLE review_jobs ADD COLUMN not_before TEXT`); } catch { /* already exists */ }
    try { this.db.exec(`ALTER TABLE review_jobs ADD COLUMN defers INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists */ }
  }

  /** Maximum consecutive rate-limit defers before the job moves to DLQ. */
  static readonly MAX_DEFERS = 10;

  enqueue(ref: PrRef): ReviewJob | null {
    const dedupKey = `${ref.host}/${ref.owner}/${ref.repo}/${ref.number}/${ref.headSha}`;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO review_jobs (id, dedup_key, host, owner, repo, pr_number, head_sha, enqueued_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(id, dedupKey, ref.host, ref.owner, ref.repo, ref.number, ref.headSha, now);

    if (result.changes === 0) return null;

    return { id, ref, enqueuedAt: new Date(now), attempts: 0 };
  }

  /**
   * Claim the next pending job. `excludeRepoFqns` are repo identifiers
   * (`host/owner/repo`) that must be skipped, used by the worker loop to
   * enforce per-repo serialization: jobs for a repo already in flight do
   * not get a second worker.
   *
   * Uses a single atomic UPDATE...WHERE id=(SELECT...) RETURNING * so the
   * select-and-flip-status step cannot race - critical if we ever go
   * multi-process or introduce an async boundary between SELECT and UPDATE.
   */
  claim(maxAttempts: number, excludeRepoFqns?: ReadonlyArray<string>): ReviewJob | null {
    const now = new Date().toISOString();
    const exclude = excludeRepoFqns && excludeRepoFqns.length > 0 ? excludeRepoFqns : null;
    const placeholders = exclude ? exclude.map(() => "?").join(",") : "";
    const sql = `
      UPDATE review_jobs
        SET status = 'running',
            attempts = attempts + 1,
            claimed_at = ?
      WHERE id = (
        SELECT id FROM review_jobs
        WHERE status = 'pending'
          AND attempts < ?
          AND (not_before IS NULL OR not_before <= ?)
          ${exclude ? `AND (host || '/' || owner || '/' || repo) NOT IN (${placeholders})` : ""}
        ORDER BY enqueued_at ASC
        LIMIT 1
      )
      RETURNING *
    `;
    const params: (string | number)[] = [now, maxAttempts, now];
    if (exclude) params.push(...exclude);
    const row = this.db.prepare(sql).get(...params) as RawRow | undefined;

    if (!row) return null;
    return rowToJob(row);
  }

  /**
   * Mark a running job as deferred without consuming a retry attempt.
   * Used by adaptive 429 backoff: rate-limited jobs return to pending with a
   * not_before timestamp and don't burn their retry budget. Caps consecutive
   * defers so a permanently-broken upstream eventually DLQs instead of cycling
   * forever. Returns "deferred" or "dlq" depending on the outcome.
   */
  delayRetry(id: string, retryAfterSec: number): "deferred" | "dlq" {
    const row = this.db.prepare("SELECT defers FROM review_jobs WHERE id = ?").get(id) as { defers: number } | undefined;
    const defers = (row?.defers ?? 0) + 1;
    if (defers >= Queue.MAX_DEFERS) {
      this.db.prepare(
        `UPDATE review_jobs
           SET status = 'dlq',
               error = ?,
               done_at = ?
         WHERE id = ?`,
      ).run(`rate-limited ${defers} times in a row, giving up`, new Date().toISOString(), id);
      return "dlq";
    }
    const not_before = new Date(Date.now() + retryAfterSec * 1000).toISOString();
    this.db.prepare(
      `UPDATE review_jobs
         SET status = 'pending',
             attempts = MAX(attempts - 1, 0),
             defers = ?,
             claimed_at = NULL,
             not_before = ?
       WHERE id = ?`,
    ).run(defers, not_before, id);
    return "deferred";
  }

  /**
   * Reset jobs left in 'running' status from a previous process (crash or kill).
   * Decrements attempts to undo the increment from the original claim, so a
   * recovered job has the same retry budget it had before the crash. Clears
   * not_before defensively so a stale defer can't strand the recovered job.
   * Returns the number of rows reset.
   */
  recoverOrphaned(): number {
    const result = this.db.prepare(
      `UPDATE review_jobs
         SET status = 'pending',
             attempts = MAX(attempts - 1, 0),
             claimed_at = NULL,
             not_before = NULL
       WHERE status = 'running'`,
    ).run();
    return result.changes;
  }

  complete(id: string): void {
    this.db.prepare(`
      UPDATE review_jobs SET status = 'done', defers = 0, done_at = ? WHERE id = ?
    `).run(new Date().toISOString(), id);
  }

  fail(id: string, error: string, maxAttempts: number): "retry" | "dlq" {
    const row = this.db.prepare("SELECT attempts FROM review_jobs WHERE id = ?").get(id) as { attempts: number } | undefined;
    const attempts = row?.attempts ?? maxAttempts;

    if (attempts < maxAttempts) {
      this.db.prepare(`UPDATE review_jobs SET status = 'pending', error = ? WHERE id = ?`).run(error, id);
      return "retry";
    }

    this.db.prepare(`UPDATE review_jobs SET status = 'dlq', error = ?, done_at = ? WHERE id = ?`)
      .run(error, new Date().toISOString(), id);
    return "dlq";
  }

  stats(): { pending: number; running: number; done: number; dlq: number } {
    const row = this.db.prepare(`
      SELECT
        COUNT(CASE WHEN status = 'pending' THEN 1 END) AS pending,
        COUNT(CASE WHEN status = 'running' THEN 1 END) AS running,
        COUNT(CASE WHEN status = 'done'    THEN 1 END) AS done,
        COUNT(CASE WHEN status = 'dlq'     THEN 1 END) AS dlq
      FROM review_jobs
    `).get() as { pending: number; running: number; done: number; dlq: number };
    return row;
  }

  audit(jobId: string, event: string, detail?: string): void {
    this.db.prepare(`INSERT INTO audit_log (job_id, event, detail, ts) VALUES (?, ?, ?, ?)`)
      .run(jobId, event, detail ?? null, new Date().toISOString());
  }

  recentAudit(limit = 50): AuditEntry[] {
    const rows = this.db.prepare(
      `SELECT job_id, event, detail, ts FROM audit_log ORDER BY id DESC LIMIT ?`,
    ).all(limit) as Array<{ job_id: string; event: string; detail: string | null; ts: string }>;
    return rows.map(r => ({
      jobId: r.job_id,
      event: r.event,
      detail: r.detail ?? "",
      ts: new Date(r.ts),
    }));
  }

  /** List DLQ jobs (most recent first). */
  listDlq(limit = 20): DlqEntry[] {
    const rows = this.db.prepare(`
      SELECT id, host, owner, repo, pr_number, head_sha, attempts, error, done_at
        FROM review_jobs
       WHERE status = 'dlq'
       ORDER BY done_at DESC
       LIMIT ?
    `).all(limit) as Array<{
      id: string; host: string; owner: string; repo: string;
      pr_number: number; head_sha: string; attempts: number;
      error: string | null; done_at: string | null;
    }>;
    return rows.map(r => ({
      id: r.id,
      ref: { host: r.host, owner: r.owner, repo: r.repo, number: r.pr_number, headSha: r.head_sha },
      attempts: r.attempts,
      error: r.error ?? "",
      dlqAt: r.done_at ? new Date(r.done_at) : null,
    }));
  }

  /** Find a job by id prefix (>=8 hex chars) or full id. Returns null if zero or multiple matches. */
  findByPrefix(prefix: string): { id: string; status: string } | null {
    if (prefix.length < 8) return null;
    const rows = this.db.prepare(
      `SELECT id, status FROM review_jobs WHERE id LIKE ? || '%' LIMIT 2`,
    ).all(prefix) as Array<{ id: string; status: string }>;
    if (rows.length !== 1) return null;
    return rows[0]!;
  }

  /** Move a DLQ job back to pending. Resets attempts so it gets a full retry budget. */
  requeueFromDlq(id: string): boolean {
    const result = this.db.prepare(
      `UPDATE review_jobs
         SET status = 'pending', attempts = 0, error = NULL, done_at = NULL, claimed_at = NULL
       WHERE id = ? AND status = 'dlq'`,
    ).run(id);
    return result.changes > 0;
  }

  /** Permanently mark a DLQ job as cancelled. */
  cancelDlq(id: string): boolean {
    const result = this.db.prepare(
      `UPDATE review_jobs SET status = 'cancelled', done_at = ? WHERE id = ? AND status = 'dlq'`,
    ).run(new Date().toISOString(), id);
    return result.changes > 0;
  }

  db_instance(): Database.Database {
    return this.db;
  }
}

export interface DlqEntry {
  id: string;
  ref: PrRef;
  attempts: number;
  error: string;
  dlqAt: Date | null;
}

export interface AuditEntry {
  jobId: string;
  event: string;
  detail: string;
  ts: Date;
}

interface RawRow {
  id: string;
  host: string;
  owner: string;
  repo: string;
  pr_number: number;
  head_sha: string;
  enqueued_at: string;
  attempts: number;
}

function rowToJob(row: RawRow): ReviewJob {
  return {
    id: row.id,
    ref: {
      host: row.host,
      owner: row.owner,
      repo: row.repo,
      number: row.pr_number,
      headSha: row.head_sha,
    },
    enqueuedAt: new Date(row.enqueued_at),
    attempts: row.attempts,
  };
}
