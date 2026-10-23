import { FlowLogRepository } from './flow-logs.js';
import {
  flowCode,
  resolveSendTiming,
  SendTimingSchema,
  ExtensionSendQueueSchema,
  ExtensionSendQueueItemSchema,
  type ExtensionSendQueue,
  type ExtensionSendQueueItem,
  type SendTiming,
} from '@wai-bridge/shared';
import { SendSettingsRepository } from './send-settings.js';
import { ConversationIdentityRepository } from './conversation-identities.js';
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  ExtensionSendRequestSchema,
  ExtensionPhoneSendRequestSchema,
  ExtensionRecipientSendRequestSchema,
  normalizeProfilePhone,
  ExtensionSendPollSchema,
  ExtensionSendProgressSchema,
  ExtensionSendCommandSchema,
  SendTargetSchema,
  sendTarget,
} from '@wai-bridge/shared';
import { CommandRepository } from './commands.js';
import { OutboxRepository, type OutboxCommand, type OutboxStatus } from './outbox.js';

const Payload = ExtensionSendRequestSchema.extend({
  conversationId: z.uuid().optional(),
  phoneRequest: ExtensionPhoneSendRequestSchema.optional(),
  nameRequest: ExtensionRecipientSendRequestSchema.optional(),
  target: SendTargetSchema,
  recipientPhone: z
    .string()
    .regex(/^\+[1-9]\d{7,14}$/)
    .optional(),
});
const terminal = ['DRAFTED', 'SENT', 'UNKNOWN', 'FAILED', 'CANCELLED'];
const terminalSql = terminal.map((status) => `'${status}'`).join(',');
const executing: OutboxStatus[] = ['CLAIMED', 'TARGET_VERIFIED', 'COMPOSED', 'WAITING_AUTO_SEND'];
const notReadyReasons = [
  'NO_WHATSAPP_TAB',
  'CONTENT_UNREACHABLE',
  'CONTENT_OUTDATED',
  'NO_MONITORED_CONTEXT',
];
const queueColumns =
  'id,status,payload_json,priority,attempt_count,result_code,created_at,updated_at';
type QueueRow = {
  id: string;
  status: string;
  payload_json: string;
  priority: number;
  attempt_count: number;
  result_code: string | null;
  created_at: string;
  updated_at: string;
};
export class ExtensionSendRepository {
  private readonly outbox: OutboxRepository;
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.outbox = new OutboxRepository(db);
  }
  create(raw: unknown, idempotencyKey: string, traceId?: string) {
    const request = ExtensionSendRequestSchema.parse(raw);
    const key = z.string().min(16).max(128).parse(idempotencyKey);
    return this.db
      .transaction(() => {
        const target = this.db
          .prepare(
            'SELECT account_id AS accountId,reference_type AS type,reference_key AS referenceKey FROM wa_conversation_identities WHERE conversation_id=?',
          )
          .get(request.conversationId);
        if (!target) throw new Error('CONFIRMED_CONVERSATION_REQUIRED');
        let recipientPhone: string | undefined;
        if (request.locateByPhone) {
          const peer = this.db
            .prepare(
              `SELECT p.phone_number AS phone,c.kind FROM wa_conversation_identities i JOIN wa_conversations c ON c.id=i.conversation_id LEFT JOIN wa_contacts p ON p.id=i.peer_contact_id WHERE i.conversation_id=?`,
            )
            .get(request.conversationId) as { phone: string | null; kind: string };
          if (peer.kind !== 'DIRECT' || !peer.phone) throw new Error('RECIPIENT_PHONE_REQUIRED');
          recipientPhone = peer.phone;
        }
        const payload = Payload.parse({
          ...request,
          target,
          ...(recipientPhone ? { recipientPhone } : {}),
        });
        const conversationId = request.conversationId;
        const serialized = JSON.stringify(payload);
        const requestHash = createHash('sha256')
          .update(JSON.stringify({ kind: 'extension-send', payload: serialized }))
          .digest('hex');
        const result = new CommandRepository(this.db).create({
          id: randomUUID(),
          kind: 'extension-send',
          idempotencyScope: 'extension-send',
          idempotencyKey: key,
          requestHash,
          payload,
          status: 'QUEUED',
          createdAt: this.now(),
        });
        if (result.inserted) this.enqueue(result.id, payload, `conv:${conversationId}`);
        return this.registerTrace(result, traceId);
      })
      .immediate();
  }
  createToName(raw: unknown, idempotencyKey: string, traceId?: string) {
    const request = ExtensionRecipientSendRequestSchema.parse(raw);
    const key = z.string().min(16).max(128).parse(idempotencyKey);
    return this.db
      .transaction(() => {
        const existing = this.db
          .prepare(
            "SELECT id,payload_json FROM wa_outbox WHERE idempotency_scope='extension-send' AND idempotency_key=?",
          )
          .get(key) as { id: string; payload_json: string } | undefined;
        if (existing) {
          if (
            JSON.stringify(Payload.parse(JSON.parse(existing.payload_json)).nameRequest) !==
            JSON.stringify(request)
          )
            throw new Error('IDEMPOTENCY_CONFLICT');
          return this.registerTrace({ id: existing.id, inserted: false }, traceId);
        }
        const accountId = this.activeAccount(request.accountId);
        const normalize = (value: string) =>
          value
            .normalize('NFD')
            .replace(/\p{M}/gu, '')
            .toLocaleLowerCase('pt-BR')
            .replace(/\s+/g, ' ')
            .trim();
        const contacts = this.db
          .prepare(
            'SELECT display_name,phone_number FROM wa_contacts WHERE account_scope=? AND display_name IS NOT NULL LIMIT 2001',
          )
          .all(`local-account:${accountId}`) as {
          display_name: string;
          phone_number: string | null;
        }[];
        if (contacts.length > 2000) throw new Error('RECIPIENT_SEARCH_TOO_BROAD');
        const name = normalize(request.recipientName);
        const exact = contacts.filter((row) => normalize(row.display_name) === name);
        const matches = exact.length
          ? exact
          : contacts.filter((row) => normalize(row.display_name).includes(name));
        if (!matches.length) throw new Error('RECIPIENT_NAME_NOT_FOUND');
        if (matches.some((row) => !row.phone_number)) throw new Error('RECIPIENT_PHONE_REQUIRED');
        const phones = new Set(matches.map((row) => row.phone_number!));
        if (phones.size !== 1) throw new Error('AMBIGUOUS_RECIPIENT');
        const body = ExtensionRecipientSendRequestSchema.omit({ recipientName: true }).parse({
          text: request.text,
          mode: request.mode,
          explicitAuthorization: request.explicitAuthorization,
          ...(request.accountId ? { accountId: request.accountId } : {}),
          ...(request.timing ? { timing: request.timing } : {}),
        });
        return this.createToNumber(
          { ...body, accountId, phoneNumber: [...phones][0]! },
          key,
          request,
          traceId,
        );
      })
      .immediate();
  }
  createToNumber(
    raw: unknown,
    idempotencyKey: string,
    nameRequest?: z.infer<typeof ExtensionRecipientSendRequestSchema>,
    traceId?: string,
  ) {
    const parsed = ExtensionPhoneSendRequestSchema.parse(raw);
    const request = { ...parsed, phoneNumber: normalizeProfilePhone(parsed.phoneNumber)! };
    const key = z.string().min(16).max(128).parse(idempotencyKey);
    return this.db
      .transaction(() => {
        const existing = this.db
          .prepare(
            "SELECT id,payload_json FROM wa_outbox WHERE idempotency_scope='extension-send' AND idempotency_key=?",
          )
          .get(key) as { id: string; payload_json: string } | undefined;
        if (existing) {
          const prior = Payload.parse(JSON.parse(existing.payload_json));
          if (
            JSON.stringify(prior.phoneRequest) !== JSON.stringify(request) ||
            JSON.stringify(prior.nameRequest) !== JSON.stringify(nameRequest)
          )
            throw new Error('IDEMPOTENCY_CONFLICT');
          return this.registerTrace({ id: existing.id, inserted: false }, traceId);
        }
        const accountId = this.activeAccount(parsed.accountId);
        const payload = Payload.parse({
          text: request.text,
          mode: request.mode,
          explicitAuthorization: true,
          locateByPhone: true,
          recipientPhone: request.phoneNumber,
          target: { accountId, type: 'PHONE', referenceKey: request.phoneNumber },
          phoneRequest: request,
          ...(request.timing ? { timing: request.timing } : {}),
          ...(nameRequest ? { nameRequest } : {}),
        });
        const serialized = JSON.stringify(payload);
        const result = new CommandRepository(this.db).create({
          id: randomUUID(),
          kind: 'extension-send',
          idempotencyScope: 'extension-send',
          idempotencyKey: key,
          requestHash: createHash('sha256')
            .update(JSON.stringify({ kind: 'extension-send', payload: serialized }))
            .digest('hex'),
          payload,
          status: 'QUEUED',
          createdAt: this.now(),
        });
        if (result.inserted) this.enqueue(result.id, payload, `phone:${request.phoneNumber}`);
        return this.registerTrace(result, traceId);
      })
      .immediate();
  }
  private activeAccount(accountId?: string): string {
    const cutoff = new Date(Date.parse(this.now()) - 15_000).toISOString();
    const contexts = this.db
      .prepare(
        "SELECT cursor FROM wa_sync_state WHERE scope LIKE 'extension-send-context:%' AND updated_at>=? AND updated_at<=?",
      )
      .all(cutoff, this.now()) as { cursor: string }[];
    const accounts = new Set(
      contexts
        .map((row) =>
          z
            .object({ accountId: z.uuid().nullable(), allowClaim: z.boolean() })
            .parse(JSON.parse(row.cursor)),
        )
        .filter((row) => row.allowClaim && row.accountId !== null)
        .map((row) => row.accountId),
    );
    if (accountId && !accounts.has(accountId)) throw new Error('ACTIVE_SEND_ACCOUNT_REQUIRED');
    if (!accountId && accounts.size !== 1)
      throw new Error(accounts.size ? 'AMBIGUOUS_SEND_ACCOUNT' : 'ACTIVE_SEND_ACCOUNT_REQUIRED');
    return accountId ?? [...accounts][0]!;
  }
  recover(): void {
    const at = this.now();
    const expired = this.db
      .prepare(
        `SELECT id FROM wa_outbox WHERE kind='extension-send' AND status NOT IN ('REQUESTED','QUEUED','WAITING_WHATSAPP',${terminalSql}) AND lease_until<=?`,
      )
      .all(at) as { id: string }[];
    for (const { id } of expired) this.interrupt(this.outbox.get(id)!, 'EXTENSION_LEASE_EXPIRED');
    const pending = this.db
      .prepare(
        "SELECT id,status,created_at,timing_json,payload_json FROM wa_outbox WHERE kind='extension-send' AND status IN ('REQUESTED','QUEUED','WAITING_WHATSAPP')",
      )
      .all() as {
      id: string;
      status: OutboxStatus;
      created_at: string;
      timing_json: string | null;
      payload_json: string;
    }[];
    for (const row of pending) {
      const maxWait = this.timingOf(row).queueMaxWaitMs;
      if (maxWait === null || Date.parse(row.created_at) + maxWait > Date.parse(at)) continue;
      this.outbox.transition(
        row.id,
        row.status,
        'FAILED',
        'extension-recovery',
        at,
        'REQUEST_EXPIRED',
        { resultCode: 'REQUEST_EXPIRED' },
      );
      new FlowLogRepository(this.db).record({
        traceId: this.traceFor(row.id),
        resourceId: row.id,
        component: 'SQLITE',
        phase: 'FAILED',
        outcome: 'FAILED',
        level: 'ERROR',
        code: 'REQUEST_EXPIRED',
      });
    }
  }
  /** Lease lost before the click: requeue in place and pause; after the click: UNKNOWN, never resent. */
  private interrupt(item: OutboxCommand, code: 'EXTENSION_LEASE_EXPIRED' | 'EXTENSION_ORPHANED') {
    const at = this.now();
    const sending = item.status === 'SENDING';
    const requeue = executing.includes(item.status);
    const next: OutboxStatus = sending ? 'UNKNOWN' : requeue ? 'QUEUED' : 'FAILED';
    const reason = requeue ? 'EXTENSION_INTERRUPTED_REQUEUED' : code;
    this.outbox.transition(item.id, item.status, next, 'extension-recovery', at, reason, {
      leaseOwner: null,
      leaseUntil: null,
      nextAttemptAt: null,
      resultCode: reason,
    });
    if (item.leaseOwner) this.outbox.releaseInterfaceLease(item.leaseOwner, item.id);
    if (requeue)
      this.db
        .prepare(
          "INSERT INTO wa_send_queue_state(singleton_id,paused,pause_reason,paused_at) VALUES(1,1,'INTERRUPTED',?) ON CONFLICT(singleton_id) DO UPDATE SET paused=1,pause_reason='INTERRUPTED',paused_at=excluded.paused_at",
        )
        .run(at);
    new FlowLogRepository(this.db).record({
      traceId: this.traceFor(item.id),
      resourceId: item.id,
      component: 'SQLITE',
      phase: requeue ? 'SEND_REQUESTED' : next === 'UNKNOWN' ? 'UNKNOWN' : 'FAILED',
      outcome: requeue ? 'WAITING' : next === 'UNKNOWN' ? 'UNKNOWN' : 'FAILED',
      level: requeue ? 'WARN' : 'ERROR',
      code: 'EXTENSION_LEASE_EXPIRED',
    });
  }
  poll(raw: unknown) {
    const input = ExtensionSendPollSchema.parse(raw);
    return this.db
      .transaction(() => {
        this.recover();
        const active = input.activeCommand ? this.outbox.get(input.activeCommand.id) : undefined;
        if (
          input.activeCommand &&
          (!active ||
            active.kind !== 'extension-send' ||
            active.leaseOwner !==
              `${input.extensionInstanceId}:${input.activeCommand.contextId}:${input.activeCommand.leaseToken}`)
        )
          throw new Error('SEND_LEASE_MISMATCH');
        if (!input.activeCommand) {
          // The extension reports no running job: anything it still holds was interrupted.
          const orphans = this.db
            .prepare(
              `SELECT id FROM wa_outbox WHERE kind='extension-send' AND status NOT IN ('REQUESTED','QUEUED','WAITING_WHATSAPP',${terminalSql}) AND substr(lease_owner,1,?)=?`,
            )
            .all(input.extensionInstanceId.length + 1, `${input.extensionInstanceId}:`) as { id: string }[];
          for (const { id } of orphans) this.interrupt(this.outbox.get(id)!, 'EXTENSION_ORPHANED');
        }
        const reason = input.reason ?? (input.ready ? 'READY' : 'TAB_HIDDEN');
        if (!input.activeCommand && (!input.ready || notReadyReasons.includes(reason)))
          this.db
            .prepare(
              "UPDATE wa_outbox SET status='WAITING_WHATSAPP',updated_at=? WHERE kind='extension-send' AND status='QUEUED'",
            )
            .run(this.now());
        if (input.ready && input.allowClaim && reason === 'READY' && !input.activeCommand) {
          this.db
            .prepare(
              "UPDATE wa_outbox SET status='QUEUED',updated_at=? WHERE kind='extension-send' AND status='WAITING_WHATSAPP'",
            )
            .run(this.now());
          this.db
            .prepare(
              'UPDATE wa_send_queue_state SET paused=0,pause_reason=NULL,paused_at=NULL WHERE singleton_id=1',
            )
            .run();
        }
        const target = input.identity ? sendTarget(input.identity) : undefined;
        const baseScope = `extension-send-context:${input.extensionInstanceId}`;
        const scope = target ? `${baseScope}:${target.accountId}` : baseScope;
        if (!target || input.protocolVersion === 2)
          this.db
            .prepare(
              "UPDATE wa_sync_state SET cursor=json_set(cursor,'$.allowClaim',json('false'),'$.ready',json('false')) WHERE scope=? OR (?=1 AND scope LIKE ?)",
            )
            .run(baseScope, !target ? 1 : 0, `${baseScope}:%`);
        const heartbeatScopes = [scope, `extension-send-health:${input.extensionInstanceId}`];
        for (const heartbeatScope of heartbeatScopes) {
          this.db
            .prepare(
              `INSERT INTO wa_sync_state(id,scope,cursor,updated_at) VALUES(?,?,?,?) ON CONFLICT(scope) DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at,version=wa_sync_state.version+1`,
            )
            .run(
              heartbeatScope,
              heartbeatScope,
              JSON.stringify({
                accountId: target?.accountId ?? null,
                allowClaim: input.allowClaim && Boolean(target),
                ready: input.visible ?? input.ready,
                reason,
                protocolVersion: input.protocolVersion ?? 1,
                clientBuild: input.clientBuild ?? null,
              }),
              this.now(),
            );
        }
        if (active) return { command: null, activeStatus: active.status };
        if (!input.identity || !target) return { command: null };
        new ConversationIdentityRepository(this.db).resolve(
          input.identity,
          input.conversationLabel ?? null,
          this.now(),
        );
        if (!input.allowClaim) return { command: null };
        if (
          this.db
            .prepare(
              "SELECT id FROM wa_dialogue_sync_requests WHERE status='CLAIMED' AND expires_at>? LIMIT 1",
            )
            .get(this.now())
        )
          return { command: null };

        const found = this.db
          .prepare(
            `SELECT id,status,timing_json,payload_json,target_key,created_at FROM wa_outbox WHERE kind='extension-send' AND status IN ('QUEUED','WAITING_WHATSAPP')
        AND json_extract(payload_json,'$.target.accountId')=? AND ((json_extract(payload_json,'$.target.type')=?
        AND json_extract(payload_json,'$.target.referenceKey')=?) OR json_extract(payload_json,'$.locateByPhone')=1) ORDER BY priority DESC,created_at,id LIMIT 1`,
          )
          .get(target.accountId, target.type, target.referenceKey) as
          | {
              id: string;
              status: OutboxStatus;
              timing_json: string | null;
              payload_json: string;
              target_key: string | null;
              created_at: string;
            }
          | undefined;
        if (!found) return { command: null };
        if (!input.ready || found.status !== 'QUEUED' || this.queueState().paused)
          return { command: null, pending: true };
        const timing = this.timingOf(found);
        const token = randomUUID();
        const owner = `${input.extensionInstanceId}:${input.identity.contextId}:${token}`;
        if (!this.outbox.acquireInterfaceLease(owner, found.id, this.now(), timing.executionTimeoutMs))
          return { command: null };
        const until = new Date(Date.parse(this.now()) + timing.executionTimeoutMs).toISOString();
        const appendToDraft = Boolean(
          found.target_key &&
            this.db
              .prepare(
                "SELECT 1 FROM wa_outbox WHERE kind='extension-send' AND status='DRAFTED' AND target_key=? AND id<>? AND (created_at<? OR (created_at=? AND id<?)) LIMIT 1",
              )
              .get(found.target_key, found.id, found.created_at, found.created_at, found.id),
        );
        const item = this.outbox.transition(
          found.id,
          'QUEUED',
          'CLAIMED',
          `extension:${input.extensionInstanceId}`,
          this.now(),
          'EXTENSION_CLAIMED',
          { leaseOwner: owner, leaseUntil: until },
        );
        this.db
          .prepare('UPDATE wa_outbox SET attempt_count=attempt_count+1 WHERE id=?')
          .run(item.id);
        const payload = Payload.parse(item.payload);
        new FlowLogRepository(this.db).record({
          traceId: this.traceFor(item.id),
          resourceId: item.id,
          component: 'SQLITE',
          phase: 'SEND_CLAIMED',
          outcome: 'SUCCEEDED',
          code: 'OK',
        });
        return {
          command: ExtensionSendCommandSchema.parse({
            id: item.id,
            traceId: this.traceFor(item.id),
            leaseToken: token,
            contextId: input.identity.contextId,
            conversationId: payload.conversationId,
            target: payload.target,
            ...(payload.locateByPhone
              ? { locateByPhone: true, recipientPhone: payload.recipientPhone }
              : {}),
            text: payload.text,
            mode: payload.mode,
            explicitAuthorization: true,
            leaseUntil: until,
            timing,
            appendToDraft,
          }),
        };
      })
      .immediate();
  }
  progress(raw: unknown) {
    const input = ExtensionSendProgressSchema.parse(raw);
    return this.db
      .transaction(() => {
        this.recover();
        const item = this.outbox.get(input.commandId);
        if (!item || item.kind !== 'extension-send') throw new Error('COMMAND_NOT_FOUND');
        const owner = `${input.extensionInstanceId}:${input.contextId}:${input.leaseToken}`;
        // Retain lease owner on terminal records for authenticated, idempotent ACK retries.
        if (item.leaseOwner !== owner) throw new Error('SEND_LEASE_MISMATCH');
        if (item.status === input.step) return { ok: true as const, status: item.status };
        if (terminal.includes(item.status) || !item.leaseUntil || item.leaseUntil <= this.now())
          throw new Error('SEND_STATE_CONFLICT');
        const payload = Payload.parse(item.payload);
        if (
          input.step === 'WAITING_AUTO_SEND' &&
          (item.status !== 'CLAIMED' || payload.mode !== 'AUTO')
        )
          throw new Error('SEND_STATE_CONFLICT');
        else if (input.step === 'WAITING_USER') throw new Error('SEND_STATE_CONFLICT');
        else if (
          input.step === 'DRAFTED' &&
          (item.status !== 'CLAIMED' || payload.mode !== 'SUPERVISED')
        )
          throw new Error('SEND_STATE_CONFLICT');
        else if (input.step === 'SENDING') {
          if (item.status !== (payload.mode === 'AUTO' ? 'WAITING_AUTO_SEND' : 'WAITING_USER'))
            throw new Error('SEND_STATE_CONFLICT');
          if (payload.mode === 'AUTO' && (!item.nextAttemptAt || item.nextAttemptAt > this.now()))
            throw new Error('COUNTDOWN_NOT_FINISHED');
        } else if (input.step === 'SENT' && item.status !== 'SENDING')
          throw new Error('SEND_STATE_CONFLICT');
        else if (input.step === 'CANCELLED' && item.status === 'SENDING')
          throw new Error('SEND_CANNOT_CANCEL');
        else if (input.step === 'FAILED' && item.status === 'SENDING')
          throw new Error('SEND_OUTCOME_UNCERTAIN');
        if (payload.locateByPhone && ['DRAFTED', 'WAITING_AUTO_SEND'].includes(input.step)) {
          const identity = input.resolvedIdentity;
          const phone =
            identity?.type === 'PHONE'
              ? identity.phone
              : identity?.type === 'UI_CONTEXT' && identity.conversationKind === 'INDIVIDUAL'
                ? identity.phone
                : undefined;
          if (
            !identity ||
            !input.conversationLabel ||
            identity.accountId !== payload.target.accountId ||
            phone !== payload.recipientPhone
          )
            throw new Error('RECIPIENT_PROOF_REQUIRED');
          const resolved = new ConversationIdentityRepository(this.db).resolve(
            identity,
            input.conversationLabel,
            this.now(),
          );
          // Persist the observed contact and associate the intent before authorizing any send.
          this.db
            .prepare('UPDATE wa_outbox SET payload_json=?,target_key=? WHERE id=?')
            .run(
              JSON.stringify({ ...payload, conversationId: resolved.conversationId }),
              `conv:${resolved.conversationId}`,
              item.id,
            );
        }
        const fields = {
          requiredLeaseOwner: owner,
          ...(input.step === 'WAITING_AUTO_SEND'
            ? {
                nextAttemptAt: new Date(
                  Date.parse(this.now()) + this.timingOf(this.rawRow(item.id)).autoCountdownMs,
                ).toISOString(),
              }
            : {}),
          ...(input.step === 'SENDING' ? { executionStartedAt: this.now() } : {}),
          resultCode: input.code,
          ...(input.evidence ? { resultRef: input.evidence } : {}),
        };
        this.outbox.transition(
          item.id,
          item.status,
          input.step,
          `extension:${input.extensionInstanceId}`,
          this.now(),
          input.code,
          fields,
        );
        new FlowLogRepository(this.db).record({
          traceId: this.traceFor(item.id),
          resourceId: item.id,
          component: 'SQLITE',
          phase: input.step === 'DRAFTED' ? 'MESSAGE_COMPOSED' : input.step,
          outcome:
            input.step === 'DRAFTED'
              ? 'SUCCEEDED'
              : input.step === 'FAILED'
              ? 'FAILED'
              : input.step === 'UNKNOWN'
                ? 'UNKNOWN'
                : input.step === 'CANCELLED'
                  ? 'CANCELLED'
                  : input.step === 'SENDING'
                    ? 'STARTED'
                    : input.step === 'SENT'
                      ? 'SUCCEEDED'
                      : 'WAITING',
          code: flowCode(input.code),
        });
        if (terminal.includes(input.step)) this.outbox.releaseInterfaceLease(owner, item.id);
        return { ok: true as const, status: input.step };
      })
      .immediate();
  }
  cancel(id: string) {
    return this.db
      .transaction(() => {
        const item = this.outbox.get(z.uuid().parse(id));
        if (!item || item.kind !== 'extension-send') throw new Error('COMMAND_NOT_FOUND');
        if (item.status === 'CANCELLED') return item;
        if (terminal.includes(item.status) || item.status === 'SENDING')
          throw new Error('SEND_CANNOT_CANCEL');
        const result = this.outbox.transition(
          id,
          item.status,
          'CANCELLED',
          'user',
          this.now(),
          'USER_CANCELLED',
          { resultCode: 'USER_CANCELLED' },
        );
        new FlowLogRepository(this.db).record({
          traceId: this.traceFor(id),
          resourceId: id,
          component: 'SQLITE',
          phase: 'CANCELLED',
          outcome: 'CANCELLED',
          code: 'USER_CANCELLED',
        });
        if (item.leaseOwner) this.outbox.releaseInterfaceLease(item.leaseOwner, id);
        return result;
      })
      .immediate();
  }
  diagnostics() {
    const now = Date.parse(this.now());
    const native = this.db
      .prepare(
        'SELECT status,last_seen_at FROM wa_extension_state ORDER BY last_seen_at DESC LIMIT 1',
      )
      .get() as { status: string; last_seen_at: string } | undefined;
    const row = this.db
      .prepare(
        "SELECT cursor,updated_at FROM wa_sync_state WHERE scope LIKE 'extension-send-context:%' OR scope LIKE 'extension-send-health:%' ORDER BY updated_at DESC,CASE WHEN scope LIKE 'extension-send-health:%' THEN 0 ELSE 1 END LIMIT 1",
      )
      .get() as { cursor: string; updated_at: string } | undefined;
    const cursor = row
      ? z
          .object({
            ready: z.boolean().optional(),
            allowClaim: z.boolean(),
            reason: z.string().max(64).optional(),
            protocolVersion: z.number().optional(),
            clientBuild: z.string().nullable().optional(),
          })
          .parse(JSON.parse(row.cursor))
      : undefined;
    const queue = this.db
      .prepare(
        `SELECT status,COUNT(*) count FROM wa_outbox WHERE kind='extension-send' AND status NOT IN (${terminalSql}) GROUP BY status`,
      )
      .all() as { status: string; count: number }[];
    return {
      native: !native
        ? 'UNSEEN'
        : now - Date.parse(native.last_seen_at) > 60000
          ? 'STALE'
          : native.status,
      bridge: !row
        ? 'UNSEEN'
        : now - Date.parse(row.updated_at) > 15000
          ? 'STALE'
          : (cursor?.reason ?? 'LEGACY_CLIENT'),
      lastPollAt: row?.updated_at ?? null,
      protocolVersion: cursor?.protocolVersion ?? null,
      build: cursor?.clientBuild ?? null,
      ready: Boolean(
        row && now - Date.parse(row.updated_at) <= 15000 && cursor?.ready && cursor.allowClaim,
      ),
      queue,
    };
  }
  queue(): ExtensionSendQueue {
    const rows = this.db
      .prepare(
        `SELECT ${queueColumns} FROM wa_outbox WHERE kind='extension-send' AND status NOT IN (${terminalSql}) ORDER BY priority DESC,created_at,id`,
      )
      .all() as QueueRow[];
    let position = 0;
    const state = this.queueState();
    return ExtensionSendQueueSchema.parse({
      ...state,
      items: rows.map((row) => {
        const item = this.queueItem(row, null);
        return item.status === 'QUEUED' || item.status === 'WAITING_WHATSAPP'
          ? { ...item, position: ++position }
          : item;
      }),
    });
  }
  status(id: string): ExtensionSendQueueItem {
    const row = this.db
      .prepare(`SELECT ${queueColumns} FROM wa_outbox WHERE kind='extension-send' AND id=?`)
      .get(z.uuid().parse(id)) as QueueRow | undefined;
    if (!row) throw new Error('COMMAND_NOT_FOUND');
    return this.queue().items.find((item) => item.id === row.id) ?? this.queueItem(row, null);
  }
  private queueItem(row: QueueRow, position: number | null): ExtensionSendQueueItem {
    // Legacy rows predate the queue: REQUESTED waited in line, WAITING_USER was mid-execution.
    const status =
      row.status === 'REQUESTED' ? 'QUEUED' : row.status === 'WAITING_USER' ? 'COMPOSED' : row.status;
    return ExtensionSendQueueItemSchema.parse({
      id: row.id,
      status,
      mode: Payload.parse(JSON.parse(row.payload_json)).mode,
      priority: row.priority,
      position,
      attempts: row.attempt_count,
      resultCode: row.result_code,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
  private queueState(): { paused: boolean; pauseReason: string | null } {
    const row = this.db
      .prepare('SELECT paused,pause_reason FROM wa_send_queue_state WHERE singleton_id=1')
      .get() as { paused: number; pause_reason: string | null } | undefined;
    return row?.paused ? { paused: true, pauseReason: row.pause_reason } : { paused: false, pauseReason: null };
  }
  private enqueue(id: string, payload: z.infer<typeof Payload>, targetKey: string) {
    const timing = resolveSendTiming(new SendSettingsRepository(this.db, this.now).get(), payload.timing);
    const priority = payload.mode === 'AUTO' && timing.autoCountdownMs === 0 ? 1 : 0;
    this.db
      .prepare('UPDATE wa_outbox SET priority=?,target_key=?,timing_json=? WHERE id=?')
      .run(priority, targetKey, JSON.stringify(SendTimingSchema.parse(timing)), id);
    this.audit(id, 'CREATED');
  }
  private rawRow(id: string) {
    return this.db.prepare('SELECT timing_json,payload_json FROM wa_outbox WHERE id=?').get(id) as {
      timing_json: string | null;
      payload_json: string;
    };
  }
  /** Timing frozen at creation; rows created before schema 17 fall back to current settings. */
  private timingOf(row: { timing_json: string | null; payload_json: string }): SendTiming {
    if (row.timing_json) return SendTimingSchema.parse(JSON.parse(row.timing_json));
    return resolveSendTiming(
      new SendSettingsRepository(this.db, this.now).get(),
      Payload.parse(JSON.parse(row.payload_json)).timing,
    );
  }
  traceFor(id: string): string {
    const row = this.db.prepare('SELECT flow_trace_id FROM wa_outbox WHERE id=?').get(id) as
      { flow_trace_id: string | null } | undefined;
    return row?.flow_trace_id ?? id;
  }
  private registerTrace(result: { id: string; inserted: boolean }, traceId?: string) {
    const trace = traceId ? z.uuid().parse(traceId) : result.id;
    this.db
      .prepare('UPDATE wa_outbox SET flow_trace_id=COALESCE(flow_trace_id,?) WHERE id=?')
      .run(trace, result.id);
    const canonical = this.traceFor(result.id);
    new FlowLogRepository(this.db).record({
      traceId: canonical,
      resourceId: result.id,
      component: 'SQLITE',
      phase: 'SEND_REQUESTED',
      outcome: 'SUCCEEDED',
      code: result.inserted ? 'COMMITTED' : 'REPLAY',
    });
    return { ...result, traceId: canonical, status: this.outbox.get(result.id)!.status };
  }
  private audit(id: string, code: string) {
    this.db
      .prepare(
        "INSERT INTO wa_audit_log(id,actor_type,actor_id,action,resource_type,resource_id,at,outcome,correlation_id,metadata_json) VALUES(?,'USER','local-api','extension-send.created','outbox',?,?,'SUCCESS',?,?)",
      )
      .run(randomUUID(), id, this.now(), id, JSON.stringify({ code }));
  }
}
