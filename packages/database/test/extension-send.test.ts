import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  openDatabase,
  ExtensionSendRepository,
  CaptureObservationRepository,
  CaptureNormalizationRepository,
  OutboxRepository,
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
      expect(repo.create({conversationId:row.id,text:'Synthetic reply',explicitAuthorization:true},'synthetic-register-key').status).toBe('REQUESTED');
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
      expect(s.poll().command).toBeNull();
      expect(() => s.progress('SENDING')).toThrow('SEND_STATE_CONFLICT');
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
        sending ? 'UNKNOWN' : 'FAILED',
      );
      expect(s.poll().command).toBeNull();
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
      expect(s.poll().command).toBeNull();
      s.repo.cancel(s.command.id);
      expect(s.poll().command?.id).toBe(second.id);
      expect(() => s.progress('SENDING')).toThrow();
    } finally {
      s.db.close();
    }
  });
});
