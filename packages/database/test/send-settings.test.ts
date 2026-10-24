import { describe, expect, it } from 'vitest';
import { DEFAULT_SEND_TIMING } from '@wai-bridge/shared';
import { applyMigrations, migrations, openDatabase, SendSettingsRepository } from '../src/index.js';

const NOW = '2026-10-22T12:00:00.000Z';
describe('SendSettingsRepository', () => {
  it('get returns defaults on empty db', () => {
    const db = openDatabase(':memory:');
    try {
      expect(new SendSettingsRepository(db, () => NOW).get()).toEqual(DEFAULT_SEND_TIMING);
    } finally {
      db.close();
    }
  });
  it('update persists merged values', () => {
    const db = openDatabase(':memory:');
    try {
      const repo = new SendSettingsRepository(db, () => NOW);
      const updated = repo.update({ autoCountdownMs: 0, queueMaxWaitMs: null });
      expect(updated).toEqual({ ...DEFAULT_SEND_TIMING, autoCountdownMs: 0, queueMaxWaitMs: null });
      expect(repo.update({ sendVerifyMs: 20_000 })).toEqual({ ...updated, sendVerifyMs: 20_000 });
      expect(new SendSettingsRepository(db).get()).toEqual({ ...updated, sendVerifyMs: 20_000 });
    } finally {
      db.close();
    }
  });
  it('update rejects out-of-range', () => {
    const db = openDatabase(':memory:');
    try {
      const repo = new SendSettingsRepository(db, () => NOW);
      expect(() => repo.update({ executionTimeoutMs: 1 })).toThrow();
      expect(repo.get()).toEqual(DEFAULT_SEND_TIMING);
    } finally {
      db.close();
    }
  });
  it('migration converts pending REQUESTED extension-send to QUEUED and leaves kind=send untouched', () => {
    const db = openDatabase(':memory:', { migrate: false });
    try {
      applyMigrations(db, migrations.slice(0, 16));
      const insert = db.prepare(
        `INSERT INTO wa_outbox(id,kind,idempotency_scope,idempotency_key,request_hash,status,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?,'{}',?,?)`,
      );
      insert.run('c1', 'extension-send', 's', 'k1', 'h', 'REQUESTED', NOW, NOW);
      insert.run('c2', 'extension-send', 's', 'k2', 'h', 'SENT', NOW, NOW);
      insert.run('c3', 'send', 's', 'k3', 'h', 'REQUESTED', NOW, NOW);
      applyMigrations(db);
      const status = (id: string) =>
        (db.prepare('SELECT status,priority,target_key,timing_json FROM wa_outbox WHERE id=?').get(id));
      expect(status('c1')).toEqual({ status: 'QUEUED', priority: 0, target_key: null, timing_json: null });
      expect(status('c2')).toMatchObject({ status: 'SENT' });
      expect(status('c3')).toMatchObject({ status: 'REQUESTED' });
      const history = db
        .prepare('SELECT command_id,from_status,to_status,actor,reason_code,correlation_id FROM wa_outbox_history')
        .all();
      expect(history).toEqual([
        { command_id: 'c1', from_status: 'REQUESTED', to_status: 'QUEUED', actor: 'migration-017', reason_code: 'MIGRATED_TO_QUEUED', correlation_id: 'c1' },
      ]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });
  it('schema version is 17', () => {
    const db = openDatabase(':memory:');
    try {
      expect(db.prepare('SELECT max(version) v FROM wa_schema_migrations').get()).toEqual({ v: 17 });
      expect(migrations.at(-1)?.name).toBe('send-queue');
    } finally {
      db.close();
    }
  });
});
