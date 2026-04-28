import type Database from "better-sqlite3";
import type { KvStore } from "@aegis/sdk";

export class SqliteKvStore implements KvStore {
  constructor(
    private readonly db: Database.Database,
    private readonly ns: string,
  ) {}

  async get(key: string): Promise<string | undefined> {
    const row = this.db.prepare("SELECT value FROM kv WHERE ns = ? AND key = ?").get(this.ns, key) as { value: string } | undefined;
    return row?.value;
  }

  async set(key: string, value: string): Promise<void> {
    this.db.prepare("INSERT OR REPLACE INTO kv (ns, key, value) VALUES (?, ?, ?)").run(this.ns, key, value);
  }

  async delete(key: string): Promise<void> {
    this.db.prepare("DELETE FROM kv WHERE ns = ? AND key = ?").run(this.ns, key);
  }

  async list(prefix: string): Promise<string[]> {
    const rows = this.db.prepare("SELECT key FROM kv WHERE ns = ? AND key LIKE ?").all(this.ns, `${prefix}%`) as { key: string }[];
    return rows.map(r => r.key);
  }
}
