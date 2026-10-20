import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ContactDirectoryRepository,
  openDatabase,
  applyMigrations,
  migrations,
} from '../src/index.js';
import { registrationBounds } from '../src/repositories/contact-directory.js';
import { ContactDirectoryQuerySchema } from '@wai-bridge/shared';
const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
});
function setup() {
  const db = openDatabase(':memory:');
  databases.push(db);
  const accountId = randomUUID();
  const repo = new ContactDirectoryRepository(db, () => new Date('2026-10-20T01:30:00.000Z')); // still October19 in Sao Paulo
  const insert = (
    name: string | null,
    at = '2026-10-19T12:00:00.000Z',
    nickname: string | null = null,
    fullName: string | null = null,
    account = accountId,
  ) => {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO wa_contacts(id,connector,account_scope,display_name,nickname,full_name,phone_number,identity_status,created_at,updated_at)
    VALUES(?,'synthetic',?,?,?,?,?,'PARTIAL',?,?)`,
    ).run(id, `local-account:${account}`, name, nickname, fullName, '+5511999990001', at, at);
    return id;
  };
  return { db, repo, insert, accountId };
}
describe('SQLite-only registered contact directory', () => {
  it('returns only real registered fields, preserves namesakes and nulls, and never creates a sync job', () => {
    const h = setup();
    h.insert('João');
    h.insert('João');
    h.insert(null, '2026-10-19T15:00:00.000Z', null, null);
    const page = h.repo.list({});
    expect(page).toMatchObject({
      total: 3,
      nextCursor: null,
      source: 'SQLITE_ONLY',
      timeZone: 'America/Sao_Paulo',
    });
    expect(page.items.filter((r) => r.name === 'João')).toHaveLength(2);
    expect(page.items.every((r) => r.nickname === null && r.fullName === null)).toBe(true);
    expect(h.db.prepare('SELECT count(*) n FROM wa_dialogue_sync_requests').get()).toEqual({
      n: 0,
    });
  });
  it('combines literal accent/case-insensitive equality, prefix or contains across stored name fields', () => {
    const h = setup();
    h.insert('João');
    h.insert('João Pedro');
    h.insert('Maria', undefined, 'Esposa', 'Maria José Silva');
    h.insert('Ana Maria');
    h.insert('Júlia');
    expect(h.repo.list({ query: 'joao', match: 'EXACT' }).items.map((r) => r.name)).toEqual([
      'João',
    ]);
    expect(h.repo.list({ query: 'j', match: 'STARTS_WITH' }).total).toBe(3);
    expect(h.repo.list({ query: 'maria', match: 'CONTAINS' }).total).toBe(2);
    expect(h.repo.list({ query: 'esposa' }).items[0]).toMatchObject({
      name: 'Maria',
      nickname: 'Esposa',
      fullName: 'Maria José Silva',
    });
    expect(h.repo.list({ query: 'JOSE', match: 'CONTAINS' }).total).toBe(1);
    expect(h.repo.list({ query: "%' OR 1=1 --" }).total).toBe(0);
    expect(h.repo.list({ query: '%' }).total).toBe(0);
  });
  it('uses local registration date rather than UTC date or last update and combines with prefix', () => {
    const h = setup();
    h.insert('João', '2026-10-19T02:59:59.999Z');
    h.insert('Júlia', '2026-10-19T03:00:00.000Z');
    h.insert('José', '2026-10-20T02:59:59.999Z');
    h.insert('Maria', '2026-10-20T03:00:00.000Z');
    const today = h.repo.list({ query: 'j', match: 'STARTS_WITH', registeredPeriod: 'TODAY' });
    expect(today.total).toBe(2);
    expect(today.registeredFromUtc).toBe('2026-10-19T03:00:00.000Z');
    expect(today.registeredBeforeUtc).toBe('2026-10-20T03:00:00.000Z');
    expect(h.repo.list({ registeredPeriod: 'YESTERDAY' }).items[0]?.name).toBe('João');
    expect(h.repo.list({ registeredOn: '2026-10-19' }).total).toBe(2);
    expect(h.repo.list({ registeredFrom: '2026-10-18', registeredTo: '2026-10-19' }).total).toBe(3);
    expect(h.repo.list({ registeredFrom: '2026-10-20' }).total).toBe(1);
    expect(h.repo.list({ registeredTo: '2026-10-18' }).total).toBe(1);
  });
  it('respects DST 23/25 hour calendar days, midnight gaps and leap days', () => {
    const bounds = (registeredOn: string, timeZone: string) =>
      registrationBounds(
        ContactDirectoryQuerySchema.parse({ registeredOn, timeZone }),
        new Date('2026-10-19T12:00:00Z'),
      );
    const fall = bounds('2026-11-01', 'America/New_York'),
      spring = bounds('2026-03-08', 'America/New_York');
    expect(Date.parse(fall.before!) - Date.parse(fall.from!)).toBe(25 * 3600000);
    expect(Date.parse(spring.before!) - Date.parse(spring.from!)).toBe(23 * 3600000);
    expect(bounds('2018-11-04', 'America/Sao_Paulo').from).toBe('2018-11-04T03:00:00.000Z');
    expect(bounds('2024-02-29', 'UTC').before).toBe('2024-03-01T00:00:00.000Z');
  });
  it('paginates all registered rows with exact totals and account scope, without deduplication by phone', () => {
    const h = setup();
    for (let i = 0; i < 5; i++) h.insert('Synthetic');
    h.insert('Foreign', undefined, null, null, randomUUID());
    const all: string[] = [];
    let cursor: string | undefined;
    do {
      const result = h.repo.list({
        accountId: h.accountId,
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      expect(result.total).toBe(5);
      all.push(...result.items.map((r) => r.id));
      cursor = result.nextCursor ?? undefined;
    } while (cursor);
    expect(new Set(all).size).toBe(5);
    expect(h.repo.list({ accountId: randomUUID() }).total).toBe(0);
  });
  it('rejects impossible/conflicting dates, malformed cursors and unsupported zones', () => {
    const h = setup();
    for (const query of [
      { registeredOn: '2026-02-30' },
      { registeredFrom: '2026-10-20', registeredTo: '2026-10-19' },
      { registeredPeriod: 'TODAY', registeredOn: '2026-10-19' },
      { timeZone: 'Invalid/Zone' },
      { cursor: 'bad' },
      { limit: 101 },
      { query: '' },
    ])
      expect(() => h.repo.list(query)).toThrow();
  });
  it('migration15 preserves existing contact names/phones and prior checksums without inventing aliases', () => {
    const db = openDatabase(':memory:', { migrate: false });
    databases.push(db);
    applyMigrations(db, migrations.slice(0, 14));
    const id = randomUUID(),
      at = '2026-10-19T12:00:00.000Z';
    db.prepare(
      "INSERT INTO wa_contacts(id,connector,account_scope,display_name,phone_number,identity_status,created_at,updated_at) VALUES(?,'synthetic','synthetic','Synthetic existing','+5511999990001','PARTIAL',?,?)",
    ).run(id, at, at);
    const checks = db.prepare('SELECT version,checksum FROM wa_schema_migrations').all();
    applyMigrations(db);
    expect(
      db.prepare('SELECT version,checksum FROM wa_schema_migrations WHERE version<=14').all(),
    ).toEqual(checks);
    expect(new ContactDirectoryRepository(db).list({}).items[0]).toMatchObject({
      id,
      name: 'Synthetic existing',
      phone: '+5511999990001',
      nickname: null,
      fullName: null,
    });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});
