import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  DialogueSyncRequestSchema,
  DialogueSyncPollSchema,
  DialogueSyncCompletionSchema,
  DialogueSyncResultSchema,
  DialogueSyncJobSchema,
  type CaptureObservation,
} from '@wai-bridge/shared';
import { ConversationIdentityRepository } from './conversation-identities.js';
import { CaptureNormalizationRepository } from './capture-normalization.js';
import { ConversationReviewRepository } from './conversation-review.js';
import { FlowLogRepository } from './flow-logs.js';

type Row = {
  id: string;
  payload_json: string;
  status: string;
  extension_instance_id: string | null;
  account_id: string | null;
  lease_token: string | null;
  result_json: string | null;
  created_at: string;
  expires_at: string;
  completed_at: string | null;
  review_conversation_id: string | null;
  review_revision: number | null;
};
export class DialogueSyncRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly now = () => new Date().toISOString(),
  ) {}
  private expire(): void {
    this.db
      .prepare(
        "UPDATE wa_dialogue_sync_requests SET status='EXPIRED',completed_at=? WHERE status IN ('REQUESTED','CLAIMED') AND expires_at<=?",
      )
      .run(this.now(), this.now());
  }
  get(id: string) {
    z.uuid().parse(id);
    this.expire();
    const row = this.db.prepare('SELECT * FROM wa_dialogue_sync_requests WHERE id=?').get(id) as
      Row | undefined;
    if (!row) throw new Error('SYNC_NOT_FOUND');
    return DialogueSyncResultSchema.parse({
      id: row.id,
      status: row.status,
      conversationId: null,
      observedCount: 0,
      persistedCount: 0,
      messageIds: [],
      unknownDirectionCount: 0,
      truncated: false,
      code: row.status === 'EXPIRED' ? 'TIMEOUT' : null,
      createdAt: row.created_at,
      completedAt: row.completed_at,
      expiresAt: row.expires_at,
      scope: 'VISIBLE_RENDERED_ONLY',
      complete: false,
      ...(row.result_json ? JSON.parse(row.result_json) : {}),
    });
  }
  create(raw: unknown) {
    const input = DialogueSyncRequestSchema.parse(raw);
    return this.db
      .transaction(() => {
        this.expire();
        const prior = this.db
          .prepare('SELECT id,payload_json FROM wa_dialogue_sync_requests WHERE idempotency_key=?')
          .get(input.idempotencyKey) as { id: string; payload_json: string } | undefined;
        if (prior) {
          if (prior.payload_json !== JSON.stringify(input)) throw new Error('IDEMPOTENCY_CONFLICT');
          return this.get(prior.id);
        }
        const reviewTargetId = input.conversationId ?? new ConversationReviewRepository(this.db).findUniqueTarget(input.query,input.accountId);
        if (reviewTargetId) {
          let reference;
          try { reference = new ConversationReviewRepository(this.db).reference(reviewTargetId); }
          catch { throw new Error('SYNC_TARGET_NOT_FOUND'); }
          if (!reference.account_id || (input.accountId && reference.account_id !== input.accountId))
            throw new Error('SYNC_ACCOUNT_MISMATCH');
          const normalize = (v: string) => v.normalize('NFC').trim().toLocaleLowerCase('pt-BR');
          if (normalize(input.query) !== normalize(reference.title ?? '') && input.query !== reference.phone)
            throw new Error('SYNC_TARGET_MISMATCH');
        }
        if (reviewTargetId && this.db.prepare("SELECT 1 FROM wa_dialogue_sync_requests WHERE review_conversation_id=? AND status IN ('REQUESTED','CLAIMED')").get(reviewTargetId))
          throw new Error('SYNC_ALREADY_PENDING');
        const pending = this.db
          .prepare(
            "SELECT COUNT(*) n FROM wa_dialogue_sync_requests WHERE status IN ('REQUESTED','CLAIMED')",
          )
          .get() as { n: number };
        if (pending.n >= 20) throw new Error('SYNC_QUEUE_FULL');
        const id = randomUUID();
        this.db
          .prepare(
            "INSERT INTO wa_dialogue_sync_requests(id,idempotency_key,payload_json,status,created_at,expires_at,review_conversation_id) VALUES(?,?,?,'REQUESTED',?,?,?)",
          )
          .run(
            id,
            input.idempotencyKey,
            JSON.stringify(input),
            this.now(),
            new Date(Date.parse(this.now()) + 30000).toISOString(),
            reviewTargetId ?? null,
          );
        if (reviewTargetId) new ConversationReviewRepository(this.db).requested(reviewTargetId, id);
        this.log(id, 'SYNC_REQUESTED');
        return this.get(id);
      })
      .immediate();
  }
  poll(raw: unknown) {
    const input = DialogueSyncPollSchema.parse(raw);
    return this.db
      .transaction(() => {
        this.expire();
        if (input.activeRequestId) {
          const active=this.db.prepare('SELECT * FROM wa_dialogue_sync_requests WHERE id=?').get(input.activeRequestId) as Row|undefined;
          if(!active || active.extension_instance_id!==input.extensionInstanceId || active.lease_token!==input.leaseToken || active.account_id!==input.accountId)
            throw new Error('SYNC_LEASE_MISMATCH');
          return {pending:false,job:null,...(['FAILED','EXPIRED'].includes(active.status)?{cancelRequestId:active.id}:{})};
        }
        const jobs = this.db
          .prepare(
            "SELECT * FROM wa_dialogue_sync_requests WHERE status='REQUESTED' ORDER BY created_at,id LIMIT 20",
          )
          .all() as Row[];
        const row = jobs.find((r) => {
          const q = DialogueSyncRequestSchema.parse(JSON.parse(r.payload_json));
          const reviewAccount = r.review_conversation_id
            ? new ConversationReviewRepository(this.db).reference(r.review_conversation_id).account_id : undefined;
          return (!input.accountId || !q.accountId || q.accountId === input.accountId) &&
            (!input.accountId || !reviewAccount || reviewAccount === input.accountId);
        });
        if (!row) return { pending: false, job: null };
        if (!input.ready || !input.accountId) return { pending: true, job: null };
        const busy = this.db
          .prepare(
            "SELECT id FROM wa_dialogue_sync_requests WHERE status='CLAIMED' UNION ALL SELECT id FROM wa_outbox WHERE status IN ('CLAIMED','TARGET_VERIFIED','COMPOSED','WAITING_USER','WAITING_AUTO_SEND','SENDING') UNION ALL SELECT command_id AS id FROM wa_outbox_interface_lease WHERE lease_until>? LIMIT 1",
          )
          .get(this.now());
        if (busy) return { pending: true, job: null };
        const lease = randomUUID();
        this.db
          .prepare(
            "UPDATE wa_dialogue_sync_requests SET status='CLAIMED',extension_instance_id=?,account_id=?,lease_token=?,review_revision=? WHERE id=? AND status='REQUESTED'",
          )
          .run(input.extensionInstanceId, input.accountId, lease,
            row.review_conversation_id ? new ConversationReviewRepository(this.db).revision(row.review_conversation_id) : null, row.id);
        const request = DialogueSyncRequestSchema.parse(JSON.parse(row.payload_json));
        this.log(row.id, 'SYNC_CLAIMED');
        return {
          pending: true,
          job: DialogueSyncJobSchema.parse({
            query: request.query,
            limit: request.limit,
            accountId: input.accountId,
            id: row.id,
            leaseToken: lease,
            expiresAt: row.expires_at,
          }),
        };
      })
      .immediate();
  }
  complete(raw: unknown, persist: (observation: CaptureObservation, instanceId: string) => void) {
    const input = DialogueSyncCompletionSchema.parse(raw);
    return this.db
      .transaction(() => {
        this.expire();
        const row = this.db
          .prepare('SELECT * FROM wa_dialogue_sync_requests WHERE id=?')
          .get(input.requestId) as Row | undefined;
        if (!row) throw new Error('SYNC_NOT_FOUND');
        if (
          row.extension_instance_id !== input.extensionInstanceId ||
          row.lease_token !== input.leaseToken
        )
          throw new Error('SYNC_LEASE_MISMATCH');
        if (row.status === 'SUCCEEDED' || row.status === 'FAILED') return this.get(row.id);
        if (row.status !== 'CLAIMED') throw new Error('SYNC_EXPIRED');
        const request = DialogueSyncRequestSchema.parse(JSON.parse(row.payload_json));
        if (input.observations.length > request.limit) throw new Error('SYNC_INVALID_RESULT');
        let conversationId: string | null = null;
        const messageIds: string[] = [];
        if (input.code === 'OK') {
          const identity = input.identity;
          if (!identity || !input.conversationLabel || identity.accountId !== row.account_id)
            throw new Error('SYNC_ACCOUNT_MISMATCH');
          const normalize = (s: string) => s.normalize('NFC').trim().toLocaleLowerCase('pt-BR');
          const query = request.query.trim();
          const phone = /^\+?[\d\s()-]+$/.test(query) ? '+' + query.replace(/\D/g, '') : undefined;
          const actualPhone =
            identity.type === 'PHONE'
              ? identity.phone
              : identity.type === 'UI_CONTEXT'
                ? identity.phone
                : undefined;
          if (
            phone
              ? actualPhone !== phone
              : !normalize(input.conversationLabel).includes(normalize(query))
          )
            throw new Error('SYNC_TARGET_MISMATCH');
          const key = (i: typeof identity) =>
            i.type === 'PHONE' ? i.phone : i.type === 'UI_CONTEXT' ? i.conversationKey : i.groupId;
          for (const observation of input.observations) {
            const observed = observation.identity;
            if (
              observation.observationType !== 'MESSAGE' ||
              !observed ||
              observed.accountId !== identity.accountId ||
              observed.type !== identity.type ||
              observed.contextId !== identity.contextId ||
              key(observed) !== key(identity) ||
              observation.conversation.label !== input.conversationLabel ||
              !observation.messageRef
            )
              throw new Error('SYNC_CONTEXT_MISMATCH');
          }
          conversationId = new ConversationIdentityRepository(this.db).resolve(
            identity,
            input.conversationLabel,
            this.now(),
          ).conversationId;
          if (row.review_conversation_id && !new ConversationReviewRepository(this.db).compatible(row.review_conversation_id, conversationId))
            throw new Error('SYNC_TARGET_MISMATCH');
          for (const observation of input.observations) {
            persist(observation, input.extensionInstanceId);
            const projected = new CaptureNormalizationRepository(this.db).normalize(
              input.extensionInstanceId,
              observation,
              false,
            );
            if (projected.conversationId !== conversationId)
              throw new Error('SYNC_CONTEXT_MISMATCH');
            const currentRef = this.db
              .prepare(
                'SELECT message_id FROM wa_capture_message_refs WHERE extension_instance_id=? AND reference_key=? AND conversation_id=?',
              )
              .get(input.extensionInstanceId, observation.messageRef!.key, conversationId) as
              { message_id: string | null } | undefined;
            const messageId = projected.messageId ?? currentRef?.message_id;
            if (messageId && !messageIds.includes(messageId)) messageIds.push(messageId);
            new FlowLogRepository(this.db).record({
              traceId: observation.observationId,
              resourceId: observation.observationId,
              relatedTraceId: row.id,
              component: 'SQLITE',
              phase: 'CAPTURE_COMMITTED',
              outcome: 'SUCCEEDED',
              code: 'COMMITTED',
            });
          }
        } else if (input.observations.length) throw new Error('SYNC_INVALID_RESULT');
        const result = {
          conversationId,
          messageIds,
          unknownDirectionCount: input.observations.filter((o) => o.direction === 'UNKNOWN').length,
          observedCount: input.observations.length,
          persistedCount: input.observations.length,
          truncated: input.truncated,
          code: input.code,
        };
        this.db
          .prepare(
            'UPDATE wa_dialogue_sync_requests SET status=?,result_json=?,completed_at=? WHERE id=?',
          )
          .run(
            input.code === 'OK' ? 'SUCCEEDED' : 'FAILED',
            JSON.stringify(result),
            this.now(),
            row.id,
          );
        if (input.code === 'OK' && row.review_conversation_id && row.review_revision !== null)
          new ConversationReviewRepository(this.db, this.now).completed(row.review_conversation_id, row.id, row.review_revision);
        this.log(row.id, 'SYNC_COMPLETED', input.code !== 'OK');
        return this.get(row.id);
      })
      .immediate();
  }
  cancelBatchJobs(batchId:string):void {
    z.uuid().parse(batchId);
    this.db.prepare(`UPDATE wa_dialogue_sync_requests SET status='FAILED',result_json=?,completed_at=?
      WHERE status IN ('REQUESTED','CLAIMED') AND id IN
      (SELECT sync_request_id FROM wa_dialogue_sync_batch_items WHERE batch_id=?)`)
      .run(JSON.stringify({code:'CANCELLED'}),this.now(),batchId);
  }
  private log(
    id: string,
    phase: 'SYNC_REQUESTED' | 'SYNC_CLAIMED' | 'SYNC_COMPLETED',
    failed = false,
  ): void {
    new FlowLogRepository(this.db).record({
      traceId: id,
      resourceId: id,
      component: 'SQLITE',
      phase,
      outcome: failed ? 'FAILED' : 'SUCCEEDED',
      code: failed ? 'UNEXPECTED_ERROR' : 'COMMITTED',
    });
  }
}
