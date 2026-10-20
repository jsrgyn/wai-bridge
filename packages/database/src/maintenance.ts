import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdtemp, copyFile, rm, stat, lstat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createConsistentBackup } from './backup.js';
import { OperationsRepository } from './repositories/operations.js';
/** Restore into a disposable directory and open that copy; never replace the running database. */
export async function verifyRestoredBackup(path: string): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), 'wai-restore-check-'));
  try {
    const target = join(dir, 'restore.sqlite');
    await copyFile(path, target);
    const clone = new Database(target, { readonly: true, fileMustExist: true });
    try {
      return (
        clone.pragma('integrity_check', { simple: true }) === 'ok' &&
        (clone.pragma('foreign_key_check') as unknown[]).length === 0
      );
    } finally {
      clone.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
export class MaintenanceService {
  private active: Promise<{ id: string; fileName: string; status: string }> | undefined;
  private ticking: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(
    private readonly db: Database.Database,
    private readonly directory: string,
  ) {}
  run() {
    if (this.active) return this.active;
    this.active = this.backup().finally(() => {
      this.active = undefined;
    });
    return this.active;
  }
  private async backup() {
    const id = randomUUID(),
      at = new Date().toISOString(),
      fileName = `wai-managed-${at.replace(/[:.]/g, '-')}-${id}.sqlite`,
      target = join(resolve(this.directory), fileName);
    this.db
      .prepare("INSERT INTO wa_backup_runs(id,file_name,status,created_at) VALUES(?,?,'RUNNING',?)")
      .run(id, fileName, at);
    try {
      await createConsistentBackup(this.db, target);
      if (!(await verifyRestoredBackup(target))) throw Error('BACKUP_VERIFY_FAILED');
      const size = (await stat(target)).size;
      this.db
        .prepare(
          "UPDATE wa_backup_runs SET status='VERIFIED',completed_at=?,size_bytes=? WHERE id=?",
        )
        .run(new Date().toISOString(), size, id);
      return { id, fileName, status: 'VERIFIED' };
    } catch {
      this.db
        .prepare(
          "UPDATE wa_backup_runs SET status='FAILED',completed_at=?,code='BACKUP_FAILED' WHERE id=?",
        )
        .run(new Date().toISOString(), id);
      throw Error('BACKUP_FAILED');
    }
  }
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.performTick().finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }
  private async performTick() {
    const policy = new OperationsRepository(this.db).maintenance().policy;
    const last = this.db
      .prepare("SELECT MAX(completed_at) at FROM wa_backup_runs WHERE status='VERIFIED'")
      .get() as { at: string | null };
    if (
      policy.backupEnabled &&
      (!last.at || Date.now() - Date.parse(last.at) >= policy.intervalHours * 3600000)
    )
      await this.run();
    if (policy.pruneBackups) {
      const rows = this.db
        .prepare(
          "SELECT id,file_name,size_bytes,created_at FROM wa_backup_runs WHERE status='VERIFIED' ORDER BY created_at DESC,id DESC",
        )
        .all() as Array<{ id: string; file_name: string; size_bytes: number; created_at: string }>;
      let total = rows.reduce((n, r) => n + r.size_bytes, 0);
      for (let i = rows.length - 1; i >= policy.minBackups; i--) {
        const row = rows[i]!;
        if (
          total <= policy.maxBackupBytes &&
          Date.now() - Date.parse(row.created_at) <= policy.retentionDays * 86400000
        )
          continue;
        if (!/^wai-managed-[0-9TZ-]+-[0-9a-f-]{36}\.sqlite$/.test(row.file_name)) continue;
        const target = join(resolve(this.directory), row.file_name);
        try {
          if (!(await lstat(target)).isFile()) continue;
          await unlink(target);
          total -= row.size_bytes;
          this.db.prepare("UPDATE wa_backup_runs SET status='PRUNED' WHERE id=?").run(row.id);
        } catch {
          /* Keep failed removals visible and retry on the next maintenance tick. */
        }
      }
    }
    if (policy.pruneLogs)
      this.db
        .prepare('DELETE FROM wa_flow_logs WHERE received_at<?')
        .run(new Date(Date.now() - policy.logRetentionDays * 86400000).toISOString());
  }
  start() {
    if (this.timer) return;
    const tick = () => {
      void this.tick().catch(() => {
        /* Persisted backup run records contain failures. */
      });
    };
    tick();
    this.timer = setInterval(tick, 60000);
    this.timer.unref();
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.ticking?.catch(() => undefined);
    await this.active?.catch(() => undefined);
  }
}
