import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { makeFlowLog, FlowLogSchema, flowCode } from '@wai-bridge/shared';
import { openDatabase, FlowLogRepository, ExtensionSendRepository } from '../src/index.js';
it('rejects personal/unstructured fields and safely classifies errors', () => {
  const event = makeFlowLog({
    traceId: randomUUID(),
    component: 'MCP',
    phase: 'MCP_TOOL',
    outcome: 'FAILED',
    code: 'UNEXPECTED_ERROR',
  });
  for (const key of [
    'text',
    'phoneNumber',
    'name',
    'token',
    'leaseToken',
    'headers',
    'stack',
    'details',
  ])
    expect(FlowLogSchema.safeParse({ ...event, [key]: 'SYNTHETIC_PRIVATE_VALUE' }).success).toBe(
      false,
    );
  expect(flowCode(new Error('SYNTHETIC_PRIVATE_VALUE'))).toBe('UNEXPECTED_ERROR');
  expect(flowCode(new Error('PROFILE_HAS_INPUT'))).toBe('PROFILE_HAS_INPUT');
});
it('deduplicates and paginates receipts without changing authoritative command state', () => {
  const db = openDatabase(':memory:');
  try {
    const repo = new FlowLogRepository(db);
    const traceId = randomUUID();
    const events = Array.from({ length: 5 }, () =>
      makeFlowLog({
        traceId,
        component: 'API',
        phase: 'API_REQUEST',
        outcome: 'SUCCEEDED',
        code: 'OK',
      }),
    );
    expect(repo.append({ events })).toEqual({ accepted: 5, inserted: 5 });
    expect(repo.append({ events })).toEqual({ accepted: 5, inserted: 0 });
    const page = repo.list({ traceId, limit: 2 });
    expect(page.items.map((e) => e.id)).toEqual(events.slice(3).map((e) => e.id));
    const older = repo.list({ traceId, limit: 2, beforeSequence: page.nextBeforeSequence });
    expect(older.items.map((e) => e.id)).toEqual(events.slice(1, 3).map((e) => e.id));
    expect(
      repo
        .list({ traceId, limit: 2, beforeSequence: older.nextBeforeSequence })
        .items.map((e) => e.id),
    ).toEqual([events[0]!.id]);
    expect(db.prepare('SELECT count(*) n FROM wa_outbox').get()).toEqual({ n: 0 });
  } finally {
    db.close();
  }
});
it('enforces seven days and the row cap without deleting audit records', () => {
  const db = openDatabase(':memory:');
  let at = '2026-10-18T12:00:00.000Z';
  try {
    const repo = new FlowLogRepository(db, () => at);
    const traceId = randomUUID();
    const event = makeFlowLog({
      traceId,
      component: 'API',
      phase: 'API_REQUEST',
      outcome: 'SUCCEEDED',
      code: 'OK',
    });
    repo.append({ events: [event] });
    at = '2026-10-26T12:00:00.000Z';
    expect(repo.list({ traceId }).items).toEqual([]);
    repo.append({ events: [{ ...event, id: randomUUID() }] });
    expect(db.prepare('SELECT count(*) n FROM wa_flow_logs').get()).toEqual({ n: 1 });
    const insert = db.prepare(
      'INSERT INTO wa_flow_logs(id,trace_id,component,level,received_at,event_json) VALUES(?,?,?,?,?,?)',
    );
    db.transaction(() => {
      for (let i = 0; i < 20000; i++)
        insert.run(randomUUID(), traceId, 'API', 'INFO', at, JSON.stringify(event));
    }).immediate();
    db.prepare(
      "INSERT INTO wa_audit_log VALUES(?,'SYSTEM','synthetic','synthetic','synthetic',?,?,'SUCCESS',?,'{}')",
    ).run(randomUUID(), traceId, at, traceId);
    repo.append({ events: [{ ...event, id: randomUUID() }] });
    expect(db.prepare('SELECT count(*) n FROM wa_flow_logs').get()).toEqual({ n: 20000 });
    expect(db.prepare('SELECT count(*) n FROM wa_audit_log').get()).toEqual({ n: 1 });
  } finally {
    db.close();
  }
});
it('keeps the original trace across idempotent retries and propagates it in a command', () => {
  const db = openDatabase(':memory:');
  try {
    const repo = new ExtensionSendRepository(db);
    const traceId = randomUUID();
    const identity = {
      version: 1 as const,
      type: 'PHONE' as const,
      source: 'PROFILE_PHONE' as const,
      phone: '+12025550199',
      accountId: randomUUID(),
      contextId: randomUUID(),
      confirmedAt: new Date().toISOString(),
    };
    const instance = randomUUID();
    repo.poll({ extensionInstanceId: instance, identity });
    const request = {
      phoneNumber: identity.phone,
      text: 'SYNTHETIC_PRIVATE_TEXT',
      explicitAuthorization: true,
    };
    const first = repo.createToNumber(request, 'synthetic-trace-replay-key', undefined, traceId);
    const replay = repo.createToNumber(
      request,
      'synthetic-trace-replay-key',
      undefined,
      randomUUID(),
    );
    expect(replay.traceId).toBe(traceId);
    expect(replay.id).toBe(first.id);
    const command = repo.poll({ extensionInstanceId: instance, identity }).command!;
    expect(command.traceId).toBe(traceId);
    const logs = new FlowLogRepository(db).list({ resourceId: first.id });
    expect(logs.resolvedTraceId).toBe(traceId);
    expect(logs.commandStatus).toBe('CLAIMED');
    expect(JSON.stringify(logs)).not.toContain(request.text);
    expect(JSON.stringify(logs)).not.toContain(identity.phone);
  } finally {
    db.close();
  }
});

it('continues durable command transitions when diagnostic persistence fails', () => {
  const db = openDatabase(':memory:');
  try {
    const repo = new ExtensionSendRepository(db);
    const identity = {
      version: 1 as const,
      type: 'PHONE' as const,
      source: 'PROFILE_PHONE' as const,
      phone: '+12025550199',
      accountId: randomUUID(),
      contextId: randomUUID(),
      confirmedAt: new Date().toISOString(),
    };
    const extensionInstanceId = randomUUID();
    repo.poll({ extensionInstanceId, identity });
    const conversation = (db.prepare('SELECT id FROM wa_conversations').get() as { id: string }).id;
    const created = repo.create(
      {
        conversationId: conversation,
        text: 'Synthetic diagnostic failure',
        mode: 'AUTO',
        explicitAuthorization: true,
        timing: { autoCountdownMs: 0 },
      },
      'synthetic-log-failure-key',
    );
    db.exec('DROP TABLE wa_flow_logs');
    const command = repo.poll({ extensionInstanceId, identity }).command!;
    const base = {
      extensionInstanceId,
      commandId: created.id,
      leaseToken: command.leaseToken,
      contextId: command.contextId,
      code: 'SYNTHETIC_STEP',
    };
    expect(repo.progress({ ...base, step: 'WAITING_AUTO_SEND' }).status).toBe('WAITING_AUTO_SEND');
    expect(repo.progress({ ...base, step: 'SENDING' }).status).toBe('SENDING');
  } finally {
    db.close();
  }
});
