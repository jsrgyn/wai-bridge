import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { openDatabase } from '../../../packages/database/src/index.js';
import { buildApp } from '../src/app.js';
const token = 'synthetic-operations-token-at-least-thirty-two-characters';
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});
async function setup() {
  const db = openDatabase(':memory:'),
    app = buildApp({ db, apiToken: token, logger: false });
  closers.push(() => app.close());
  const request = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload ? { payload } : {}),
    });
  return { db, app, request };
}
it('creates and edits a local catalog with explicit authorization, optimistic concurrency and idempotent replay', async () => {
  const h = await setup(),
    input = {
      accountId: randomUUID(),
      name: 'Synthetic Person',
      nickname: 'Esposa',
      fullName: 'Synthetic Full Name',
      phone: '+5511999990001',
      relationships: ['esposa'],
      explicitConfirmation: true,
      idempotencyKey: randomUUID(),
    };
  const created = await h.request('POST', '/api/contact-catalog', input);
  expect(created.statusCode).toBe(201);
  const contact = created.json();
  expect(contact).toMatchObject({ nickname: 'Esposa', version: 1, phoneSource: 'USER_ASSERTED' });
  expect((await h.request('POST', '/api/contact-catalog', input)).json().id).toBe(contact.id);
  const update = {
    nickname: 'Synthetic Alias',
    expectedVersion: 1,
    explicitConfirmation: true,
    idempotencyKey: randomUUID(),
  };
  expect(
    (await h.request('PATCH', `/api/contact-catalog/${contact.id}`, update)).json(),
  ).toMatchObject({ nickname: 'Synthetic Alias', version: 2 });
  expect(
    (
      await h.request('PATCH', `/api/contact-catalog/${contact.id}`, {
        ...update,
        idempotencyKey: randomUUID(),
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (await h.request('GET', '/api/contacts/directory?query=synthetic%20alias')).json().total,
  ).toBe(1);
  expect(h.db.prepare('SELECT phone_number FROM wa_contacts WHERE id=?').get(contact.id)).toEqual({
    phone_number: null,
  });
});
it('rejects unconfirmed edits and exposes a bounded operational summary and configurable safe retention', async () => {
  const h = await setup();
  expect(
    (await h.request('POST', '/api/contact-catalog', { explicitConfirmation: false })).statusCode,
  ).toBe(400);
  const summary = await h.request('GET', '/api/operations');
  expect(summary.statusCode).toBe(200);
  expect(summary.json()).toMatchObject({
    coverageComplete: false,
    counts: { contacts: 0, pending: 0 },
  });
  const settings = (await h.request('GET', '/api/maintenance')).json().policy;
  expect(settings).toMatchObject({ backupEnabled: true, pruneBackups: false, pruneLogs: false });
  expect(
    (
      await h.request('POST', '/api/maintenance', {
        ...settings,
        pruneBackups: true,
        explicitConfirmation: true,
      })
    ).statusCode,
  ).toBe(400);
});
it('stores read policies independently without deleting data or changing identity', async () => {
  const h = await setup(),
    id = randomUUID(),
    at = new Date().toISOString();
  h.db
    .prepare(
      "INSERT INTO wa_conversations(id,connector,account_scope,kind,title,created_at,updated_at) VALUES(?,'synthetic','synthetic','GROUP','Synthetic group',?,?)",
    )
    .run(id, at, at);
  const result = await h.request('POST', `/api/conversation-policies/${id}`, {
    favorite: true,
    priority: 20,
    batchMode: 'INDIVIDUAL_ONLY',
    explicitConfirmation: true,
  });
  expect(result.statusCode).toBe(200);
  expect(result.json()).toMatchObject({ favorite: true, batchMode: 'INDIVIDUAL_ONLY' });
  expect((await h.request('GET', `/api/conversation-policies/${id}`)).json().priority).toBe(20);
  expect(h.db.prepare('SELECT count(*) n FROM wa_conversations').get()).toEqual({ n: 1 });
});
it('searches explicit relationships using literal equality and detects reused request conflicts', async () => {
  const h = await setup(),
    input = {
      accountId: randomUUID(),
      name: 'Synthetic Maria',
      nickname: null,
      fullName: null,
      phone: null,
      relationships: ['esposa'],
      explicitConfirmation: true,
      idempotencyKey: randomUUID(),
    };
  expect((await h.request('POST', '/api/contact-catalog', input)).statusCode).toBe(201);
  expect(
    (await h.request('GET', '/api/contacts/directory?query=ESPOSA&match=EXACT')).json().total,
  ).toBe(1);
  expect(
    (await h.request('POST', '/api/contact-catalog', { ...input, name: 'Other' })).statusCode,
  ).toBe(409);
});
