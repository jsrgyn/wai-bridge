import { it, expect } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/database.js';
import { MaintenanceService, verifyRestoredBackup } from '../src/maintenance.js';
it('creates a private consistent backup and validates a restored copy without deleting canonical data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wai-maintenance-'));
  const db = openDatabase(join(dir, 'source.sqlite'));
  try {
    const service = new MaintenanceService(db, join(dir, 'backups'));
    const result = await service.run();
    expect(result.status).toBe('VERIFIED');
    expect((await stat(join(dir, 'backups', result.fileName))).mode & 0o777).toBe(0o600);
    expect(await verifyRestoredBackup(join(dir, 'backups', result.fileName))).toBe(true);
    expect(db.prepare('SELECT count(*) n FROM wa_schema_migrations').get()).toEqual({ n: 17 });
    await service.tick();
    expect(db.prepare('SELECT count(*) n FROM wa_backup_runs').get()).toEqual({ n: 1 });
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
it('prunes only managed excess backups after explicit deletion authorization and preserves the minimum', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wai-prune-'));
  const db = openDatabase(join(dir, 'source.sqlite'));
  try {
    const { OperationsRepository } = await import('../src/repositories/operations.js');
    const repo = new OperationsRepository(db),
      service = new MaintenanceService(db, join(dir, 'backups'));
    const first = await service.run();
    await service.run();
    await service.run();
    db.prepare("UPDATE wa_backup_runs SET created_at='2020-01-01T00:00:00.000Z' WHERE id=?").run(
      first.id,
    );
    await service.tick();
    expect(
      db.prepare("SELECT COUNT(*) n FROM wa_backup_runs WHERE status='VERIFIED'").get(),
    ).toEqual({ n: 3 });
    repo.setMaintenance({
      ...repo.maintenance().policy,
      backupEnabled: false,
      pruneBackups: true,
      minBackups: 1,
      retentionDays: 1,
      authorizeDeletion: true,
      explicitConfirmation: true,
    });
    await service.tick();
    expect(db.prepare('SELECT status FROM wa_backup_runs WHERE id=?').get(first.id)).toEqual({
      status: 'PRUNED',
    });
    expect(db.prepare('SELECT COUNT(*) n FROM wa_contacts').get()).toEqual({ n: 0 });
    expect(
      db.prepare("SELECT COUNT(*) n FROM wa_backup_runs WHERE status='VERIFIED'").get(),
    ).toEqual({ n: 2 });
    expect(
      await verifyRestoredBackup(
        join(
          dir,
          'backups',
          (
            repo
              .maintenance()
              .runs.find((r: unknown) => (r as { status: string }).status === 'VERIFIED') as {
              fileName: string;
            }
          ).fileName,
        ),
      ),
    ).toBe(true);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
it('does not delete an external path injected into backup metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wai-prune-path-'));
  const db = openDatabase(join(dir, 'source.sqlite'));
  try {
    const { OperationsRepository } = await import('../src/repositories/operations.js');
    const repo = new OperationsRepository(db),
      service = new MaintenanceService(db, join(dir, 'backups'));
    await service.run();
    db.prepare(
      "INSERT INTO wa_backup_runs(id,file_name,status,created_at,size_bytes) VALUES('11111111-1111-4111-8111-111111111111','../source.sqlite','VERIFIED','2020-01-01T00:00:00.000Z',999999999)",
    ).run();
    repo.setMaintenance({
      ...repo.maintenance().policy,
      backupEnabled: false,
      pruneBackups: true,
      minBackups: 1,
      authorizeDeletion: true,
      explicitConfirmation: true,
    });
    await service.tick();
    expect((await stat(join(dir, 'source.sqlite'))).isFile()).toBe(true);
    expect(db.prepare("SELECT status FROM wa_backup_runs WHERE id='11111111-1111-4111-8111-111111111111'").get()).toEqual({
      status: 'VERIFIED',
    });
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
