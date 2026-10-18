import Database from 'better-sqlite3';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { applyMigrations } from './migrations.js';

export interface DatabaseOptions {
  readonly busyTimeoutMs?: number;
  readonly migrate?: boolean;
  readonly readonly?: boolean;
}
export function openDatabase(path: string, options: DatabaseOptions = {}): Database.Database {
  const resolved = path === ':memory:' ? path : resolve(path);
  if (resolved !== ':memory:' && !options.readonly)
    mkdirSync(dirname(resolved), { recursive: true, mode: 0o700 });
  const db = new Database(resolved, {
    readonly: options.readonly ?? false,
    fileMustExist: options.readonly ?? false,
    timeout: options.busyTimeoutMs ?? 5000,
  });
  if (resolved !== ':memory:' && !options.readonly) chmodSync(resolved, 0o600);
  db.pragma('foreign_keys = ON');
  if (!options.readonly) {
    db.pragma('journal_mode = WAL');
    db.pragma(`busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs ?? 5000))}`);
    if (options.migrate !== false) applyMigrations(db);
  }
  return db;
}
