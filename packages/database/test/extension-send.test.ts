import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  openDatabase,
  ExtensionSendRepository,
  CaptureObservationRepository,
  CaptureNormalizationRepository,
  OutboxRepository,
  SendSettingsRepository,
} from '../src/index.js';

function setup() {
  const db = openDatabase(':memory:');
  let at = '2026-10-18T12:00:00.000Z';
  const repo = new ExtensionSendRepository(db, () => at);
  const identity = {
    version: 1 as const,
    type: 'PHONE' as const,
    source: 'PROFILE_PHONE' as const,
    phone: '+12025550123',
    accountId: randomUUID(),
    contextId: randomUUID(),
    confirmedAt: at,
  };
  const extensionInstanceId = randomUUID();
  const observation = {
    kind: 'CAPTURE_OBSERVATION' as const,
    observationId: randomUUID(),
    observedAt: at,
    observationType: 'MESSAGE' as const,
    captureState: 'CAPTURED' as const,
    conversation: { label: 'Synthetic person', kind: 'INDIVIDUAL' as const },
    senderLabel: null,
    direction: 'INBOUND' as const,
    content: 'Synthetic',
    contentAvailability: 'AVAILABLE' as const,
    media: [],
    identity,
  };
  // Use the actual staging/normalization contract to establish a confirmed reference.
  new CaptureObservationRepository(db).record(extensionInstanceId, observation, () => {
    const id = randomUUID();
    db.prepare(
      "INSERT INTO wa_events(id,event_type,aggregate_type,aggregate_id,occurred_at,payload_version,payload_json,sequence) VALUES(?,'synthetic','capture-observation',?,?,1,'{}',1)",
    ).run(id, observation.observationId, at);
    return id;
  });
  const normalized = new CaptureNormalizationRepository(db).normalize(
    extensionInstanceId,
    observation,
  );
  const request = {
    conversationId: normalized.conversationId,
    text: 'Synthetic reply ❤️',
    mode: 'AUTO' as const,
    explicitAuthorization: true as const,
  };
  const created = repo.create(request, 'synthetic-key-00001');
  const poll = () => repo.poll({ extensionInstanceId, identity });
  const command = poll().command!;
  const pollActive = () =>
    repo.poll({
      extensionInstanceId,
      identity,
      ready: false,
      reason: 'EXECUTING',
      activeCommand: { id: command.id, contextId: identity.contextId, leaseToken: command.leaseToken },
    });
  const progress = (
    step:
      | 'WAITING_AUTO_SEND'
      | 'WAITING_USER'
      | 'SENDING'
      | 'SENT'
      | 'UNKNOWN'
      | 'FAILED'
      | 'CANCELLED',
    extra = {},
  ) =>
    repo.progress({
      extensionInstanceId,
      contextId: identity.contextId,
      leaseToken: command.leaseToken,
      commandId: command.id,
      step,
      code: 'SYNTHETIC_STEP',
      ...extra,
    });
  return {
    db,
    repo,
    identity,
    request,
    extensionInstanceId,
    created,
    command,
    poll,
    pollActive,
    progress,
    setTime: (value: string) => {
      at = value;
    },
  };
}
describe('extension send queue', () => {
  it('registers an explicitly confirmed context before any new message',()=>{
    const db=openDatabase(':memory:');try{
      const repo=new ExtensionSendRepository(db);
      const identity={version:1 as const,type:'PHONE' as const,source:'PROFILE_PHONE' as const,phone:'+12025550124',accountId:randomUUID(),contextId:randomUUID(),confirmedAt:new Date().toISOString()};
      expect(repo.poll({extensionInstanceId:randomUUID(),identity,conversationLabel:'Synthetic registered contact'}).command).toBeNull();
      const row=db.prepare('SELECT id,title FROM wa_conversations').get() as {id:string;title:string};
      expect(row.title).toBe('Synthetic registered contact');
      expect(repo.create({conversationId:row.id,text:'Synthetic reply',explicitAuthorization:true},'synthetic-register-key').status).toBe('QUEUED');
      expect(db.prepare('SELECT COUNT(*) n FROM wa_messages').get()).toEqual({n:0});
    }finally{db.close();}
  });

  it('persists intent, deduplicates and enforces countdown before SENDING', () => {
    const s = setup();
    try {
      expect(s.repo.create(s.request, 'synthetic-key-00001')).toMatchObject({
        id: s.created.id,
        inserted: false,
      });
      expect(() =>
        s.repo.create({ ...s.request, text: 'different' }, 'synthetic-key-00001'),
      ).toThrow('IDEMPOTENCY_CONFLICT');
      expect(JSON.stringify(s.db.prepare('SELECT actor_id,metadata_json FROM wa_audit_log').all())).not.toContain(s.command.leaseToken);
      expect(s.pollActive().command).toBeNull();
      expect(() => s.progress('SENDING')).toThrow('SEND_STATE_CONFLICT');
      expect(() => s.progress('WAITING_USER')).toThrow('SEND_STATE_CONFLICT');
      s.progress('WAITING_AUTO_SEND');
      expect(() => s.progress('SENDING')).toThrow('COUNTDOWN_NOT_FINISHED');
      s.setTime('2026-10-18T12:00:05.000Z');
      s.progress('SENDING');
      expect(() => s.repo.cancel(s.command.id)).toThrow('SEND_CANNOT_CANCEL');
      expect(() => s.progress('SENT')).toThrow();
      const evidence = `visible-outbound:${'a'.repeat(64)}`;
      expect(s.progress('SENT', { evidence }).status).toBe('SENT');
      expect(s.progress('SENT', { evidence }).status).toBe('SENT');
      expect(
        s.db
          .prepare(
            "SELECT COUNT(*) n FROM wa_outbox_history WHERE command_id=? AND to_status='SENT'",
          )
          .get(s.command.id),
      ).toEqual({ n: 1 });
    } finally {
      s.db.close();
    }
  });
  it('rejects unknown recipients, wrong context/lease and isolates legacy dispatcher', () => {
    const s = setup();
    try {
      expect(() =>
        s.repo.create({ ...s.request, conversationId: randomUUID() }, 'synthetic-key-00002'),
      ).toThrow('CONFIRMED_CONVERSATION_REQUIRED');
      expect(
        s.repo.poll({
          extensionInstanceId: s.extensionInstanceId,
          identity: { ...s.identity, accountId: randomUUID() },
        }).command,
      ).toBeNull();
      expect(() =>
        s.repo.progress({
          extensionInstanceId: s.extensionInstanceId,
          contextId: randomUUID(),
          leaseToken: s.command.leaseToken,
          commandId: s.command.id,
          step: 'FAILED',
          code: 'SYNTHETIC_STEP',
        }),
      ).toThrow('SEND_LEASE_MISMATCH');
      const legacy = new OutboxRepository(s.db);
      expect(legacy.nextRequested()).toBeUndefined();
      expect(legacy.claimNext('legacy', '2026-10-18T12:00:00.000Z', 30_000)).toBeUndefined();
      expect(legacy.recoverExpired('2026-10-18T12:05:00.000Z')).toBe(0);
    } finally {
      s.db.close();
    }
  });
  it.each([false, true])('never requeues expired execution, SENDING=%s', (sending) => {
    const s = setup();
    try {
      if (sending) {
        s.progress('WAITING_AUTO_SEND');
        s.setTime('2026-10-18T12:00:05.000Z');
        s.progress('SENDING');
      }
      s.setTime('2026-10-18T12:04:00.000Z');
      s.repo.recover();
      expect(new OutboxRepository(s.db).get(s.command.id)?.status).toBe(
        sending ? 'UNKNOWN' : 'QUEUED',
      );
      expect(s.poll().command?.id).toBe(sending ? undefined : s.command.id);
    } finally {
      s.db.close();
    }
  });
  it('cancels before clicking and serializes access to the send interface', () => {
    const s = setup();
    try {
      const second = s.repo.create(
        { ...s.request, text: 'Second synthetic reply' },
        'synthetic-key-00002',
      );
      expect(s.pollActive().command).toBeNull();
      s.repo.cancel(s.command.id);
      expect(s.poll().command?.id).toBe(second.id);
      expect(() => s.progress('SENDING')).toThrow();
    } finally {
      s.db.close();
    }
  });
});

function queueSetup() {
  const s = setup();
  // Finish the setup command so each test starts with an idle queue.
  s.progress('FAILED');
  let keys = 0;
  // Each request is created one second after the previous one so creation order is observable.
  const create = (extra: Record<string, unknown> = {}) => {
    keys++;
    s.setTime(new Date(Date.parse('2026-10-18T12:00:00.000Z') + keys * 1000).toISOString());
    return s.repo.create(
      { ...s.request, mode: 'SUPERVISED', ...extra },
      `synthetic-queue-key-${String(keys).padStart(4, '0')}`,
    ).id;
  };
  const step = (
    command: { id: string; leaseToken: string },
    value: 'WAITING_AUTO_SEND' | 'SENDING' | 'DRAFTED' | 'FAILED',
  ) =>
    s.repo.progress({
      extensionInstanceId: s.extensionInstanceId,
      contextId: s.identity.contextId,
      leaseToken: command.leaseToken,
      commandId: command.id,
      step: value,
      code: 'SYNTHETIC_STEP',
    });
  const active = (command: { id: string; leaseToken: string }) =>
    s.repo.poll({
      extensionInstanceId: s.extensionInstanceId,
      identity: s.identity,
      ready: false,
      reason: 'EXECUTING',
      activeCommand: { id: command.id, contextId: s.identity.contextId, leaseToken: command.leaseToken },
    });
  const status = (id: string) => new OutboxRepository(s.db).get(id)!;
  return { ...s, create, step, active, status };
}

describe('extension send queue ordering and recovery', () => {
  it('serves three requests in creation order', () => {
    const q = queueSetup();
    try {
      const ids = [q.create(), q.create(), q.create()];
      const served: string[] = [];
      for (let i = 0; i < 3; i++) {
        const command = q.poll().command!;
        served.push(command.id);
        q.step(command, 'DRAFTED');
      }
      expect(served).toEqual(ids);
      expect(ids.map((id) => q.status(id).status)).toEqual(['DRAFTED', 'DRAFTED', 'DRAFTED']);
      expect(q.poll().command).toBeNull();
    } finally {
      q.db.close();
    }
  });
  it('priority request jumps ahead of waiting ones but not the running one', () => {
    const q = queueSetup();
    try {
      const a = q.create();
      const running = q.poll().command!;
      expect(running.id).toBe(a);
      q.create();
      const c = q.create({ mode: 'AUTO', timing: { autoCountdownMs: 0 } });
      expect(q.active(running)).toMatchObject({ command: null, activeStatus: 'CLAIMED' });
      expect(q.status(a).status).toBe('CLAIMED');
      q.step(running, 'DRAFTED');
      const next = q.poll().command!;
      expect(next.id).toBe(c);
      expect(next.timing.autoCountdownMs).toBe(0);
      q.step(next, 'WAITING_AUTO_SEND');
      expect(q.step(next, 'SENDING').status).toBe('SENDING');
    } finally {
      q.db.close();
    }
  });
  it('supervised ends DRAFTED and frees the queue', () => {
    const q = queueSetup();
    try {
      const a = q.create();
      const b = q.create();
      const command = q.poll().command!;
      expect(q.step(command, 'DRAFTED').status).toBe('DRAFTED');
      expect(q.db.prepare('SELECT COUNT(*) n FROM wa_outbox_interface_lease').get()).toEqual({ n: 0 });
      expect(q.status(a).status).toBe('DRAFTED');
      expect(() => q.repo.cancel(a)).toThrow('SEND_CANNOT_CANCEL');
      expect(q.poll().command?.id).toBe(b);
      expect(q.repo.diagnostics().queue).toEqual([{ status: 'CLAIMED', count: 1 }]);
    } finally {
      q.db.close();
    }
  });
  it('AUTO cannot end DRAFTED', () => {
    const q = queueSetup();
    try {
      q.create({ mode: 'AUTO' });
      const command = q.poll().command!;
      expect(() => q.step(command, 'DRAFTED')).toThrow('SEND_STATE_CONFLICT');
    } finally {
      q.db.close();
    }
  });
  it('appendToDraft true only when same target has earlier DRAFTED', () => {
    const q = queueSetup();
    try {
      q.create();
      q.create();
      const first = q.poll().command!;
      expect(first.appendToDraft).toBe(false);
      q.step(first, 'DRAFTED');
      const second = q.poll().command!;
      expect(second.appendToDraft).toBe(true);
      q.step(second, 'FAILED');
      const other = q.repo.createToNumber(
        { phoneNumber: '+5500000000001', text: 'Synthetic other', explicitAuthorization: true },
        'synthetic-queue-other-target',
      );
      const third = q.poll().command!;
      expect(third.id).toBe(other.id);
      expect(third.appendToDraft).toBe(false);
    } finally {
      q.db.close();
    }
  });
  it('requeue keeps original position and pauses queue', () => {
    const q = queueSetup();
    try {
      const a = q.create();
      const b = q.create();
      const createdAt = q.status(a).createdAt;
      const command = q.poll().command!;
      q.db.prepare("UPDATE wa_outbox SET status='COMPOSED' WHERE id=?").run(a);
      expect(q.status(a).attemptCount).toBe(1);
      q.setTime('2026-10-18T12:02:00.000Z');
      q.repo.recover();
      expect(q.status(a)).toMatchObject({
        status: 'QUEUED',
        attemptCount: 1,
        createdAt,
        leaseOwner: null,
        resultCode: 'EXTENSION_INTERRUPTED_REQUEUED',
      });
      expect(q.db.prepare('SELECT COUNT(*) n FROM wa_outbox_interface_lease').get()).toEqual({ n: 0 });
      expect(q.repo.queue()).toMatchObject({ paused: true, pauseReason: 'INTERRUPTED' });
      expect(q.repo.status(a).position).toBe(1);
      expect(
        q.repo.poll({
          extensionInstanceId: q.extensionInstanceId,
          identity: q.identity,
          reason: 'AMBIGUOUS_TABS',
        }).command,
      ).toBeNull();
      expect(() => q.step(command, 'DRAFTED')).toThrow('SEND_LEASE_MISMATCH');
      const again = q.poll().command!;
      expect(again.id).toBe(a);
      expect(q.status(a).attemptCount).toBe(2);
      expect(q.repo.queue().paused).toBe(false);
      expect(q.repo.status(b).position).toBe(1);
    } finally {
      q.db.close();
    }
  });
  it('orphan from same instance requeued on poll without activeCommand', () => {
    const q = queueSetup();
    try {
      const a = q.create();
      const command = q.poll().command!;
      q.repo.poll({ extensionInstanceId: randomUUID(), identity: q.identity, ready: true });
      expect(q.status(a).status).toBe('CLAIMED');
      expect(
        q.repo.poll({
          extensionInstanceId: q.extensionInstanceId,
          identity: q.identity,
          ready: false,
          reason: 'NO_WHATSAPP_TAB',
        }).command,
      ).toBeNull();
      expect(q.status(a).status).toBe('WAITING_WHATSAPP');
      expect(q.repo.queue().paused).toBe(true);
      expect(
        q.db
          .prepare("SELECT COUNT(*) n FROM wa_outbox_history WHERE command_id=? AND reason_code='EXTENSION_INTERRUPTED_REQUEUED'")
          .get(a),
      ).toEqual({ n: 1 });
      const resumed = q.poll().command!;
      expect(resumed.id).toBe(a);
      expect(resumed.leaseToken).not.toBe(command.leaseToken);
    } finally {
      q.db.close();
    }
  });
  it('SENDING lease expiry ends UNKNOWN and is never requeued', () => {
    const q = queueSetup();
    try {
      const a = q.create({ mode: 'AUTO', timing: { autoCountdownMs: 0 } });
      const command = q.poll().command!;
      q.step(command, 'WAITING_AUTO_SEND');
      q.step(command, 'SENDING');
      q.setTime('2026-10-18T12:02:00.000Z');
      expect(q.poll().command).toBeNull();
      expect(q.status(a).status).toBe('UNKNOWN');
      expect(q.repo.queue().items).toEqual([]);
      q.setTime('2026-10-18T13:00:00.000Z');
      expect(q.poll().command).toBeNull();
      expect(q.status(a).attemptCount).toBe(1);
    } finally {
      q.db.close();
    }
  });
  it('orphaned SENDING from same instance ends UNKNOWN', () => {
    const q = queueSetup();
    try {
      const a = q.create({ mode: 'AUTO', timing: { autoCountdownMs: 0 } });
      const command = q.poll().command!;
      q.step(command, 'WAITING_AUTO_SEND');
      q.step(command, 'SENDING');
      expect(q.poll().command).toBeNull();
      expect(q.status(a).status).toBe('UNKNOWN');
    } finally {
      q.db.close();
    }
  });
  it('no WhatsApp marks queue WAITING_WHATSAPP and READY restores QUEUED', () => {
    const q = queueSetup();
    try {
      const a = q.create();
      expect(
        q.repo.poll({
          extensionInstanceId: q.extensionInstanceId,
          identity: q.identity,
          reason: 'CONTENT_UNREACHABLE',
        }),
      ).toEqual({ command: null, pending: true });
      expect(q.repo.status(a)).toMatchObject({ status: 'WAITING_WHATSAPP', position: 1 });
      q.repo.poll({ extensionInstanceId: q.extensionInstanceId, identity: q.identity, allowClaim: false });
      expect(q.status(a).status).toBe('WAITING_WHATSAPP');
      q.repo.poll({ extensionInstanceId: q.extensionInstanceId, ready: true });
      expect(q.status(a).status).toBe('QUEUED');
      expect(q.poll().command?.id).toBe(a);
    } finally {
      q.db.close();
    }
  });
  it('queue max wait counts from created_at; null never expires', () => {
    const q = queueSetup();
    try {
      const a = q.create();
      const b = q.create({ timing: { queueMaxWaitMs: null } });
      q.repo.poll({ extensionInstanceId: q.extensionInstanceId, identity: q.identity, ready: false });
      q.setTime('2026-10-18T12:31:00.000Z');
      q.repo.recover();
      expect(q.status(a)).toMatchObject({ status: 'FAILED', resultCode: 'REQUEST_EXPIRED' });
      expect(q.status(b).status).toBe('WAITING_WHATSAPP');
      q.setTime('2026-10-19T13:00:00.000Z');
      q.repo.recover();
      expect(q.status(b).status).toBe('WAITING_WHATSAPP');
      expect(q.poll().command?.id).toBe(b);
    } finally {
      q.db.close();
    }
  });
  it('cancel allowed in QUEUED, WAITING_WHATSAPP, WAITING_AUTO_SEND; rejected in SENDING', () => {
    const q = queueSetup();
    try {
      const queued = q.create();
      expect(q.repo.cancel(queued).status).toBe('CANCELLED');
      const waiting = q.create();
      q.repo.poll({ extensionInstanceId: q.extensionInstanceId, identity: q.identity, ready: false });
      expect(q.status(waiting).status).toBe('WAITING_WHATSAPP');
      expect(q.repo.cancel(waiting).status).toBe('CANCELLED');
      const auto = q.create({ mode: 'AUTO' });
      const command = q.poll().command!;
      expect(command.id).toBe(auto);
      q.step(command, 'WAITING_AUTO_SEND');
      expect(q.repo.cancel(auto).status).toBe('CANCELLED');
      expect(q.db.prepare('SELECT COUNT(*) n FROM wa_outbox_interface_lease').get()).toEqual({ n: 0 });
      const sending = q.create({ mode: 'AUTO', timing: { autoCountdownMs: 0 } });
      const second = q.poll().command!;
      q.step(second, 'WAITING_AUTO_SEND');
      q.step(second, 'SENDING');
      expect(() => q.repo.cancel(sending)).toThrow('SEND_CANNOT_CANCEL');
    } finally {
      q.db.close();
    }
  });
  it('execution lease uses configured executionTimeoutMs', () => {
    const q = queueSetup();
    try {
      new SendSettingsRepository(q.db).update({ executionTimeoutMs: 20_000 });
      const a = q.create();
      const b = q.create({ timing: { executionTimeoutMs: 90_000 } });
      const command = q.poll().command!;
      expect(command.leaseUntil).toBe('2026-10-18T12:00:22.000Z');
      expect(command.timing.executionTimeoutMs).toBe(20_000);
      expect(q.status(a).leaseUntil).toBe('2026-10-18T12:00:22.000Z');
      expect(q.db.prepare('SELECT lease_until FROM wa_outbox_interface_lease').get()).toEqual({
        lease_until: '2026-10-18T12:00:22.000Z',
      });
      q.step(command, 'DRAFTED');
      expect(q.poll().command?.leaseUntil).toBe('2026-10-18T12:01:32.000Z');
      expect(q.status(b).status).toBe('CLAIMED');
    } finally {
      q.db.close();
    }
  });
  it('queue() reports positions and omits message text', () => {
    const q = queueSetup();
    try {
      const a = q.create();
      const b = q.create();
      const c = q.create({ mode: 'AUTO', timing: { autoCountdownMs: 0 } });
      expect(q.poll().command?.id).toBe(c);
      const queue = q.repo.queue();
      expect(queue.paused).toBe(false);
      expect(queue.items.map((item) => [item.id, item.status, item.position, item.priority])).toEqual([
        [c, 'CLAIMED', null, 1],
        [a, 'QUEUED', 1, 0],
        [b, 'QUEUED', 2, 0],
      ]);
      expect(JSON.stringify(queue)).not.toContain('Synthetic reply');
      expect(q.repo.status(b)).toMatchObject({ position: 2, attempts: 0, mode: 'SUPERVISED' });
      expect(() => q.repo.status(randomUUID())).toThrow('COMMAND_NOT_FOUND');
    } finally {
      q.db.close();
    }
  });
});
