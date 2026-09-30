import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

/** Small, transactional, single-user state store shared by MCP and local CLI.
 * No network awaits may be performed inside atomic(). SQLite, not a JSON
 * read/overwrite cycle, protects concurrent subscriptions/dispatches. */
export class StateDatabase {
  readonly db: DatabaseSync;
  private depth = 0;
  private closed = false;
  constructor(readonly filename: string) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const oldMask = process.umask(0o077);
    try { this.db = new DatabaseSync(filename); } finally { process.umask(oldMask); }
    fs.chmodSync(filename, 0o600);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    this.db.exec('CREATE TABLE IF NOT EXISTS objects (bucket TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(bucket,key));');
    this.db.exec("CREATE INDEX IF NOT EXISTS outbox_due ON objects(json_extract(value,'$.state'),json_extract(value,'$.nextAttemptAt')) WHERE bucket='outbox';");
    this.db.exec("CREATE INDEX IF NOT EXISTS outbox_event ON objects(json_extract(value,'$.eventId')) WHERE bucket='outbox';");
    this.db.exec("CREATE INDEX IF NOT EXISTS run_task ON objects(json_extract(value,'$.task')) WHERE bucket='runs';");
  }
  get<T>(bucket: string, key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM objects WHERE bucket=? AND key=?').get(bucket, key);
    return row ? JSON.parse(String(row.value)) as T : undefined;
  }
  all<T>(bucket: string): T[] {
    return this.db.prepare('SELECT value FROM objects WHERE bucket=? ORDER BY key').all(bucket)
      .map(row => JSON.parse(String(row.value)) as T);
  }
  count(bucket: string): number { return Number(this.db.prepare('SELECT count(*) AS n FROM objects WHERE bucket=?').get(bucket)?.n ?? 0); }
  recent<T>(bucket: string, limit = 40, task?: string): T[] {
    const rows = task
      ? this.db.prepare("SELECT value FROM objects WHERE bucket=? AND json_extract(value,'$.task')=? ORDER BY rowid DESC LIMIT ?").all(bucket, task, limit)
      : this.db.prepare('SELECT value FROM objects WHERE bucket=? ORDER BY rowid DESC LIMIT ?').all(bucket, limit);
    return rows.map(row => JSON.parse(String(row.value)) as T);
  }
  put<T>(bucket: string, key: string, value: T): void {
    this.db.prepare('INSERT INTO objects VALUES (?,?,?) ON CONFLICT(bucket,key) DO UPDATE SET value=excluded.value')
      .run(bucket, key, JSON.stringify(value));
  }
  remove(bucket: string, key: string): void { this.db.prepare('DELETE FROM objects WHERE bucket=? AND key=?').run(bucket, key); }
  atomic<T>(fn: () => T): T {
    if (this.depth) return fn();
    this.db.exec('BEGIN IMMEDIATE'); this.depth++;
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.depth--; }
  }
  close(): void { if (!this.closed) { this.db.close(); this.closed = true; } }
}
