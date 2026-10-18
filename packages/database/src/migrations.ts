import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}
const migrationDirectory = new URL('./migrations/', import.meta.url);
function loadMigration(version: number, name: string, fileName: string): Migration {
  const path = fileURLToPath(new URL(fileName, migrationDirectory));
  const sql = readFileSync(path, 'utf8');
  return { version, name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
}
export const migrations: readonly Migration[] = [
  loadMigration(1, 'initial-schema', '001-initial.sql'),
  loadMigration(2, 'event-delivery-leases', '002-event-delivery-leases.sql'),
  loadMigration(3, 'capture-observations', '003-capture-observations.sql'),
  loadMigration(4, 'media-storage', '004-media-storage.sql'),
  loadMigration(5, 'ai-consumer-leases', '005-ai-consumer-leases.sql'),
  loadMigration(6, 'outbox-engine', '006-outbox-engine.sql'),
  loadMigration(7, 'capture-normalization', '007-capture-normalization.sql'),
  loadMigration(8, 'conversation-identities', '008-conversation-identities.sql'),
  loadMigration(9, 'automatic-ui-context', '009-automatic-ui-context.sql'),
  loadMigration(10, 'contact-phone', '010-contact-phone.sql'),
];

export function applyMigrations(
  db: Database.Database,
  list: readonly Migration[] = migrations,
): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS wa_schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)`,
  );
  const applied = db
    .prepare('SELECT version, checksum FROM wa_schema_migrations ORDER BY version')
    .all() as { version: number; checksum: string }[];
  for (const row of applied) {
    const migration = list.find((item) => item.version === row.version);
    if (!migration || migration.checksum !== row.checksum)
      throw new Error(`Applied migration ${row.version} is missing or has changed`);
  }
  for (const migration of list) {
    if (applied.some((row) => row.version === migration.version)) continue;
    const transaction = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare(
        'INSERT INTO wa_schema_migrations(version,name,checksum,applied_at) VALUES(?,?,?,?)',
      ).run(migration.version, migration.name, migration.checksum, new Date().toISOString());
    });
    transaction.immediate();
  }
}
