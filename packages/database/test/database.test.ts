import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CommandRepository,
  MessageRepository,
  AIMessageStateRepository,
  createConsistentBackup,
  openDatabase,
  applyMigrations,
  migrations,
} from '../src/index.js';
const directories: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'wai-db-'));
  directories.push(dir);
  const db = openDatabase(join(dir, 'test.sqlite'), { busyTimeoutMs: 2000 });
  const now = '2026-10-17T12:00:00.000Z';
  db.prepare(
    'INSERT INTO wa_conversations(id,connector,account_scope,kind,created_at,updated_at) VALUES(?,?,?,?,?,?)',
  ).run('00000000-0000-7000-8000-000000000001', 'test', 'fixture', 'DIRECT', now, now);
  return { db, dir, now };
}
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function msg(id: string, seq: number, now: string, key = `test-key-${id}-0000`) {
  return {
    id,
    conversationId: '00000000-0000-7000-8000-000000000001',
    direction: 'INBOUND' as const,
    captureStatus: 'CAPTURED' as const,
    content: `synthetic message ${seq}`,
    contentAvailability: 'AVAILABLE' as const,
    observedAt: now,
    sequence: seq,
    idempotencyScope: 'fixture',
    idempotencyKey: key,
  };
}
describe('SQLite database engine', () => {
  it('preserves schema 7 normalization links while enabling grouped conversations',()=>{
    const db=openDatabase(':memory:',{migrate:false});
    try {
      applyMigrations(db,migrations.slice(0,7));
      const conversation='11111111-1111-4111-8111-111111111111';const observation='22222222-2222-4222-8222-222222222222';
      db.prepare(`INSERT INTO wa_conversations(id,connector,account_scope,kind,created_at,updated_at) VALUES(?,'fixture','synthetic','GROUP',?,?)`).run(conversation,'2026-10-18T12:00:00Z','2026-10-18T12:00:00Z');
      db.prepare(`INSERT INTO wa_capture_observations(id,extension_instance_id,observation_type,capture_state,observed_at,payload_json) VALUES(?,'fixture','CONVERSATION_ACTIVITY','DETECTED',?,'{}')`).run(observation,'2026-10-18T12:00:00Z');
      db.prepare(`INSERT INTO wa_capture_normalizations(observation_id,conversation_id,status) VALUES(?,?,'CONVERSATION_ONLY')`).run(observation,conversation);
      applyMigrations(db);
      expect(db.prepare('SELECT observation_id,conversation_id FROM wa_capture_normalizations').all()).toEqual([{observation_id:observation,conversation_id:conversation}]);
      expect(db.pragma('foreign_key_check')).toEqual([]);expect(db.pragma('integrity_check',{simple:true})).toBe('ok');
    }finally{db.close();}
  });
  it('upgrades schema 6 without changing existing rows or migration checksums', () => {
    const db = openDatabase(':memory:', { migrate: false });
    try {
      applyMigrations(db, migrations.slice(0, 6));
      const id = '00000000-0000-7000-8000-000000000099';
      db.prepare(`INSERT INTO wa_conversations(id,connector,account_scope,kind,title,created_at,updated_at)
        VALUES(?,'fixture','upgrade','UNKNOWN','Synthetic existing chat',?,?)`).run(id,'2026-10-17T12:00:00.000Z','2026-10-17T12:00:00.000Z');
      const before = db.prepare('SELECT version, checksum FROM wa_schema_migrations ORDER BY version').all();
      applyMigrations(db);
      expect(db.prepare('SELECT version, checksum FROM wa_schema_migrations WHERE version<=6 ORDER BY version').all()).toEqual(before);
      expect(db.prepare('SELECT title FROM wa_conversations WHERE id=?').get(id)).toEqual({title:'Synthetic existing chat'});
      expect(db.prepare('SELECT COUNT(*) n FROM wa_capture_normalizations').get()).toEqual({n:0});
      expect(db.pragma('integrity_check', {simple:true})).toBe('ok');expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally { db.close(); }
  });
  it('initializes pragmas and migrations idempotently', () => {
    const { db } = fixture();
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.prepare('SELECT count(*) n FROM wa_schema_migrations').get()).toEqual({ n: 11 });
    applyMigrations(db);
    expect(db.prepare('SELECT count(*) n FROM wa_schema_migrations').get()).toEqual({ n: 11 });
    db.close();
  });
  it('inserts, queries recent messages and deduplicates idempotently', () => {
    const { db, now } = fixture();
    const repo = new MessageRepository(db);
    const a = repo.insert(msg('00000000-0000-7000-8000-000000000010', 1, now));
    expect(a.inserted).toBe(true);
    expect(
      repo.insert(
        msg('00000000-0000-7000-8000-000000000011', 2, now, 'fixture-idempotency-key-0001'),
      ),
    ).toMatchObject({ inserted: true });
    expect(repo.listRecent({ limit: 1 })[0]?.id).toBe('00000000-0000-7000-8000-000000000011');
    expect(repo.getById(a.id)).toBeDefined();
  });
  it('preserves FK relationships', () => {
    const { db, now } = fixture();
    expect(() =>
      new MessageRepository(db).insert({
        ...msg('00000000-0000-7000-8000-000000000012', 1, now),
        conversationId: randomUUID(),
      }),
    ).toThrow();
  });
  it('rolls back related writes atomically', () => {
    const { db, now } = fixture();
    const tx = db.transaction(() => {
      db.prepare("INSERT INTO wa_sync_state(id,scope,cursor,updated_at) VALUES('1','x','c',?)").run(
        now,
      );
      throw new Error('abort');
    });
    expect(() => tx()).toThrow('abort');
    expect(db.prepare('SELECT count(*) n FROM wa_sync_state').get()).toEqual({ n: 0 });
  });
  it('initializes AI state UNREAD and GET-style read has no mutation', () => {
    const { db, now } = fixture();
    const repo = new MessageRepository(db);
    const result = repo.insert(msg('00000000-0000-7000-8000-000000000013', 1, now));
    const states = new AIMessageStateRepository(db);
    expect(states.get(result.id)?.state).toBe('UNREAD');
    repo.getById(result.id);
    expect(states.get(result.id)?.state).toBe('UNREAD');
    states.set(result.id, 'READ', now);
    expect(states.get(result.id)?.state).toBe('READ');
    expect(
      db
        .prepare("SELECT count(*) n FROM wa_audit_log WHERE action='ai-message-state.changed'")
        .get(),
    ).toEqual({ n: 1 });
  });
  it('keeps AI state per consumer, expires leases, requires explicit ACK, and recovers failures', () => {
    const { db, now } = fixture(); const id='00000000-0000-7000-8000-000000000031';
    new MessageRepository(db).insert(msg(id,1,now)); const states=new AIMessageStateRepository(db);
    expect(states.getForConsumer(id,'agent-a')).toBeUndefined();
    const claim=states.claimForConsumer(id,'agent-a',now,1000);
    expect(claim.attempts).toBe(1);
    expect(claim.leaseUntil).toBe('2026-10-17T12:00:01.000Z');
    expect(() => states.claimForConsumer(id,'agent-a',now,1000)).toThrow('STATE_CONFLICT');
    expect(states.claimForConsumer(id,'agent-b',now,1000).state).toBe('CLAIMED');
    expect(() => states.acknowledgeForConsumer(id,'agent-a',claim.claimToken,'2026-10-17T12:00:00.500Z')).not.toThrow();
    const recoveryId='00000000-0000-7000-8000-000000000032';new MessageRepository(db).insert(msg(recoveryId,2,now));
    const recoveryClaim=states.claimForConsumer(recoveryId,'agent-a',now,1000);
    expect(states.listRecoverable('agent-a','2026-10-17T12:00:00.500Z')).toEqual([]);
    expect(states.listRecoverable('agent-a','2026-10-17T12:00:01.000Z')).toContainEqual({messageId:recoveryId,leaseExpired:true});
    expect(()=>states.failForConsumer(recoveryId,'agent-a',recoveryClaim.claimToken,'MODEL_UNAVAILABLE','2026-10-17T12:00:01.000Z')).toThrow('ACK_FORBIDDEN');
    states.failForConsumer(recoveryId,'agent-a',recoveryClaim.claimToken,'MODEL_UNAVAILABLE','2026-10-17T12:00:00.500Z');
    expect(states.getForConsumer(recoveryId,'agent-a')).toMatchObject({state:'FAILED',lastErrorCode:'MODEL_UNAVAILABLE'});
    expect(states.listRecoverable('agent-a','2026-10-17T12:00:00.500Z')).toContainEqual({messageId:recoveryId,leaseExpired:false});
    expect(states.claimForConsumer(recoveryId,'agent-a','2026-10-17T12:00:00.600Z',1000).attempts).toBe(2);
  });
  it('persists commands and returns the same command for duplicate keys', () => {
    const { db, now } = fixture();
    const payload = { recipient: 'synthetic' };
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ kind: 'send', payload: JSON.stringify(payload) }))
      .digest('hex');
    const repo = new CommandRepository(db);
    const item = {
      id: randomUUID(),
      kind: 'send',
      idempotencyScope: 'test',
      idempotencyKey: 'command-idempotency-0001',
      requestHash,
      status: 'REQUESTED',
      payload,
      createdAt: now,
    };
    const first = repo.create(item);
    expect(first.inserted).toBe(true);
    expect(repo.create({ ...item, id: randomUUID() }).id).toBe(first.id);
    expect(db.prepare('SELECT count(*) n FROM wa_outbox_history').get()).toEqual({ n: 1 });
    repo.transition({
      commandId: first.id,
      toStatus: 'QUEUED',
      actor: 'test-consumer',
      at: now,
      correlationId: 'synthetic-correlation',
    });
    expect(db.prepare('SELECT count(*) n FROM wa_outbox_history').get()).toEqual({ n: 2 });
    expect(
      db.prepare("SELECT count(*) n FROM wa_audit_log WHERE action='outbox.status.changed'").get(),
    ).toEqual({ n: 1 });
  });
  it('creates a consistent backup and reopens it', async () => {
    const { db, dir } = fixture();
    await createConsistentBackup(db, join(dir, 'backup.sqlite'));
    const copy = openDatabase(join(dir, 'backup.sqlite'), { readonly: true });
    expect(copy.prepare('SELECT count(*) n FROM wa_conversations').get()).toEqual({ n: 1 });
    copy.close();
  });
  it('survives restart and serializes competing writers with busy timeout', () => {
    const { db, dir, now } = fixture();
    new MessageRepository(db).insert(msg('00000000-0000-7000-8000-000000000014', 1, now));
    db.close();
    const reopened = openDatabase(join(dir, 'test.sqlite'));
    expect(new MessageRepository(reopened).listRecent()).toHaveLength(1);
    const tx = reopened.transaction(() => {
      reopened
        .prepare("INSERT INTO wa_sync_state(id,scope,cursor,updated_at) VALUES('sync','a','1',?)")
        .run(now);
    });
    tx.immediate();
    expect(reopened.prepare('SELECT count(*) n FROM wa_sync_state').get()).toEqual({ n: 1 });
  });
  it('supports FTS5 search', () => {
    const { db, now } = fixture();
    new MessageRepository(db).insert(msg('00000000-0000-7000-8000-000000000015', 1, now));
    expect(new MessageRepository(db).search('synthetic')).toHaveLength(1);
  });
});
