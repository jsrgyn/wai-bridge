import { FlowLogRepository } from './flow-logs.js';
import { flowCode } from '@wai-bridge/shared';
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
import { OutboxRepository } from './outbox.js';

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
const terminal = ['SENT', 'UNKNOWN', 'FAILED', 'CANCELLED'];
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
          status: 'REQUESTED',
          createdAt: this.now(),
        });
        if (result.inserted) this.audit(result.id, 'CREATED');
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
          status: 'REQUESTED',
          createdAt: this.now(),
        });
        if (result.inserted) this.audit(result.id, 'CREATED');
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
        "SELECT id FROM wa_outbox WHERE kind='extension-send' AND status NOT IN ('REQUESTED','SENT','UNKNOWN','FAILED','CANCELLED') AND lease_until<=?",
      )
      .all(at) as { id: string }[];
    for (const { id } of expired) {
      const item = this.outbox.get(id)!;
      this.outbox.transition(
        id,
        item.status,
        item.status === 'SENDING' ? 'UNKNOWN' : 'FAILED',
        'extension-recovery',
        at,
        'EXTENSION_LEASE_EXPIRED',
        { leaseOwner: null, leaseUntil: null, resultCode: 'EXTENSION_LEASE_EXPIRED' },
      );
      new FlowLogRepository(this.db).record({
        traceId: this.traceFor(id),
        resourceId: id,
        component: 'SQLITE',
        phase: item.status === 'SENDING' ? 'UNKNOWN' : 'FAILED',
        outcome: item.status === 'SENDING' ? 'UNKNOWN' : 'FAILED',
        level: 'ERROR',
        code: 'EXTENSION_LEASE_EXPIRED',
      });
    }
    const cutoff = new Date(Date.parse(at) - 300_000).toISOString();
    const stale = this.db
      .prepare(
        "SELECT id FROM wa_outbox WHERE kind='extension-send' AND status='REQUESTED' AND created_at<?",
      )
      .all(cutoff) as { id: string }[];
    for (const { id } of stale) {
      this.outbox.transition(
        id,
        'REQUESTED',
        'FAILED',
        'extension-recovery',
        at,
        'REQUEST_EXPIRED',
        { resultCode: 'REQUEST_EXPIRED' },
      );
      new FlowLogRepository(this.db).record({
        traceId: this.traceFor(id),
        resourceId: id,
        component: 'SQLITE',
        phase: 'FAILED',
        outcome: 'FAILED',
        level: 'ERROR',
        code: 'REQUEST_EXPIRED',
      });
    }
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
                reason: input.reason ?? (input.ready ? 'READY' : 'TAB_HIDDEN'),
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
        if (this.db.prepare("SELECT id FROM wa_dialogue_sync_requests WHERE status='CLAIMED' AND expires_at>? LIMIT 1").get(this.now())) return { command: null };

        const found = this.db
          .prepare(
            `SELECT id FROM wa_outbox WHERE kind='extension-send' AND status='REQUESTED'
        AND json_extract(payload_json,'$.target.accountId')=? AND ((json_extract(payload_json,'$.target.type')=?
        AND json_extract(payload_json,'$.target.referenceKey')=?) OR json_extract(payload_json,'$.locateByPhone')=1) ORDER BY created_at,id LIMIT 1`,
          )
          .get(target.accountId, target.type, target.referenceKey) as { id: string } | undefined;
        if (!found) return { command: null };
        if (!input.ready) return { command: null, pending: true };
        const token = randomUUID();
        const owner = `${input.extensionInstanceId}:${input.identity.contextId}:${token}`;
        if (!this.outbox.acquireInterfaceLease(owner, found.id, this.now(), 180_000))
          return { command: null };
        const until = new Date(Date.parse(this.now()) + 180_000).toISOString();
        const item = this.outbox.transition(
          found.id,
          'REQUESTED',
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
        else if (
          input.step === 'WAITING_USER' &&
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
        if (payload.locateByPhone && ['WAITING_USER', 'WAITING_AUTO_SEND'].includes(input.step)) {
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
            .prepare('UPDATE wa_outbox SET payload_json=? WHERE id=?')
            .run(JSON.stringify({ ...payload, conversationId: resolved.conversationId }), item.id);
        }
        const fields = {
          requiredLeaseOwner: owner,
          ...(input.step === 'WAITING_AUTO_SEND'
            ? { nextAttemptAt: new Date(Date.parse(this.now()) + 5000).toISOString() }
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
          phase: input.step,
          outcome:
            input.step === 'FAILED'
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
        "SELECT status,COUNT(*) count FROM wa_outbox WHERE kind='extension-send' AND status NOT IN ('SENT','UNKNOWN','FAILED','CANCELLED') GROUP BY status",
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
