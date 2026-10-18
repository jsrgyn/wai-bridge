import type Database from 'better-sqlite3';
import { chmod } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export async function createConsistentBackup(
  db: Database.Database,
  destination: string,
): Promise<void> {
  const target = resolve(destination);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await db.backup(target);
  await chmod(target, 0o600);
}
