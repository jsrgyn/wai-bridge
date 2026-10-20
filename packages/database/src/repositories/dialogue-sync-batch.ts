import { OperationsRepository } from './operations.js';
import { RetryBatchFailuresSchema } from '@wai-bridge/shared';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  DialogueSyncBatchReportSchema,
  DialogueSyncBatchRequestSchema,
  DialogueSyncBatchStatusSchema,
  DialogueSyncBatchPageSchema,
  DialogueSyncBatchPageQuerySchema,
  DialogueSyncBatchActionSchema,
  DialogueSyncBatchResumeSchema,
} from '@wai-bridge/shared';
import { ConversationReviewRepository } from './conversation-review.js';
import { DialogueSyncRepository } from './dialogue-sync.js';

type Batch = {
  id: string;
  run_token: string;
  account_id: string | null;
  status: string;
  reason: string | null;
  paused_position: number | null;
  payload_json: string;
  created_at: string;
  expires_at: string;
  completed_at: string | null;
};
type Item = {
  batch_id: string;
  position: number;
  conversation_id: string;
  query: string | null;
  status: string;
  sync_request_id: string | null;
  attempts: number;
  code: string | null;
};
const safetyCodes = new Set([
  'UI_UNSUPPORTED',
  'MONITOR_OFF',
  'TAB_HIDDEN',
  'CONTENT_UNREACHABLE',
  'CONTENT_OUTDATED',
  'AMBIGUOUS_TABS',
  'ACCOUNT_MISMATCH',
  'COMPOSER_HAS_DRAFT',
  'SEARCH_PANEL_BUSY',
  'SEARCH_CHANGED',
  'USER_INTERFERENCE',
  'CONTEXT_CHANGED',
  'TIMEOUT',
  'INVALID_RESULT',
  'SYNC_FAILED',
  'SYNC_PARSE_FAILED',
  'CANCELLED',
]);
export class DialogueSyncBatchRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly now = () => new Date().toISOString(),
  ) {}
  private row(id: string): Batch {
    z.uuid().parse(id);
    const row = this.db.prepare('SELECT * FROM wa_dialogue_sync_batches WHERE id=?').get(id) as
      Batch | undefined;
    if (!row) throw new Error('BATCH_NOT_FOUND');
    return row;
  }
  private busy(except?: string): boolean {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM wa_dialogue_sync_batches WHERE status='RUNNING' AND id<>?")
        .get(except ?? ''),
    );
  }
  create(raw: unknown) {
    const input = DialogueSyncBatchRequestSchema.parse(raw);
    return this.db
      .transaction(() => {
        const prior = this.db
          .prepare('SELECT id,payload_json FROM wa_dialogue_sync_batches WHERE idempotency_key=?')
          .get(input.idempotencyKey) as { id: string; payload_json: string } | undefined;
        if (prior) {
          if (prior.payload_json !== JSON.stringify(input)) throw new Error('IDEMPOTENCY_CONFLICT');
          return this.get(prior.id);
        }
        this.refresh();
        if (this.busy()) throw new Error('BATCH_BUSY');
        const selected =
          input.scope === 'SELECTED'
            ? input.conversationIds!
            : (
                this.db
                  .prepare(
                    `SELECT r.conversation_id id FROM wa_conversation_reviews r
          LEFT JOIN wa_conversation_identities i ON i.conversation_id=r.conversation_id
          LEFT JOIN wa_conversation_policies p ON p.conversation_id=r.conversation_id
          WHERE r.revision>r.acknowledged_revision AND (? IS NULL OR i.account_id=?)
          ORDER BY COALESCE(p.favorite,0) DESC,COALESCE(p.priority,0) DESC,r.last_activity_at,r.conversation_id LIMIT 5001`,
                  )
                  .all(input.accountId ?? null, input.accountId ?? null) as Array<{ id: string }>
              ).map((r) => r.id);
        if (selected.length > 5000) throw new Error('BATCH_TOO_LARGE');
        const reviews = new ConversationReviewRepository(this.db);
        const refs = selected.map((id) => {
          try {
            return reviews.reference(id);
          } catch {
            throw new Error('BATCH_TARGET_NOT_FOUND');
          }
        });
        const accounts = new Set(
          refs.map((r) => r.account_id).filter((id): id is string => Boolean(id)),
        );
        if (input.accountId && [...accounts].some((id) => id !== input.accountId))
          throw new Error('BATCH_ACCOUNT_MISMATCH');
        if (!input.accountId && accounts.size > 1) throw new Error('BATCH_ACCOUNT_REQUIRED');
        const accountId = input.accountId ?? [...accounts][0] ?? null;
        if (selected.length && !accountId) throw new Error('BATCH_ACCOUNT_REQUIRED');
        const id = randomUUID(),
          at = this.now();
        this.db
          .prepare(
            `INSERT INTO wa_dialogue_sync_batches(id,idempotency_key,payload_json,account_id,run_token,status,created_at,expires_at,completed_at)
        VALUES(?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            id,
            input.idempotencyKey,
            JSON.stringify(input),
            accountId,
            randomUUID(),
            selected.length ? 'RUNNING' : 'COMPLETED',
            at,
            new Date(Date.parse(at) + 86400000).toISOString(),
            selected.length ? null : at,
          );
        for (const [position, ref] of refs.entries()) {
          const pending = this.db
            .prepare(
              'SELECT 1 FROM wa_conversation_reviews WHERE conversation_id=? AND revision>acknowledged_revision',
            )
            .get(ref.id);
          const query = ref.phone ?? ref.title;
          const valid =
            ref.account_id === accountId &&
            query &&
            query.trim().length >= 2 &&
            query.trim().length <= 100;
          const mode = new OperationsRepository(this.db).policy(ref.id).batchMode;
          const code =
            mode !== 'INCLUDE'
              ? `POLICY_${mode}`
              : !pending
                ? 'NO_LONGER_PENDING'
                : !valid
                  ? 'TARGET_UNAVAILABLE'
                  : null;
          this.db
            .prepare(
              `INSERT INTO wa_dialogue_sync_batch_items(batch_id,position,conversation_id,query,status,code) VALUES(?,?,?,?,?,?)`,
            )
            .run(
              id,
              position,
              ref.id,
              query,
              code
                ? code === 'NO_LONGER_PENDING' || code.startsWith('POLICY_')
                  ? 'SKIPPED'
                  : 'FAILED'
                : 'WAITING',
              code,
            );
        }
        this.audit(id, 'dialogue.batch-requested', { count: refs.length });
        this.schedule(id);
        return this.get(id);
      })
      .immediate();
  }
  // Observation of persisted outcomes never creates another navigation job.
  private refresh(id?: string): void {
    const rows = this.db
      .prepare(
        "SELECT * FROM wa_dialogue_sync_batches WHERE status IN ('RUNNING','PAUSED') AND (? IS NULL OR id=?)",
      )
      .all(id ?? null, id ?? null) as Batch[];
    for (const batch of rows) {
      if (batch.expires_at <= this.now()) {
        this.stop(batch.id, 'EXPIRED');
        continue;
      }
      const item = this.db
        .prepare("SELECT * FROM wa_dialogue_sync_batch_items WHERE batch_id=? AND status='ACTIVE'")
        .get(batch.id) as Item | undefined;
      if (!item?.sync_request_id) continue;
      const child = new DialogueSyncRepository(this.db, this.now).get(item.sync_request_id);
      if (child.status === 'REQUESTED' || child.status === 'CLAIMED') continue;
      const code = child.code ?? 'TIMEOUT';
      this.db
        .prepare(
          'UPDATE wa_dialogue_sync_batch_items SET status=?,code=? WHERE batch_id=? AND position=?',
        )
        .run(child.status === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED', code, batch.id, item.position);
      if (child.status !== 'SUCCEEDED' && safetyCodes.has(code))
        this.db
          .prepare(
            "UPDATE wa_dialogue_sync_batches SET status='PAUSED',reason=?,paused_position=? WHERE id=? AND status='RUNNING'",
          )
          .run(code, item.position, batch.id);
    }
    for (const batch of rows) this.finish(batch.id);
  }
  private finish(id: string): void {
    const counts = this.db
      .prepare(
        `SELECT SUM(status IN ('WAITING','ACTIVE')) unfinished,SUM(status='FAILED') failed FROM wa_dialogue_sync_batch_items WHERE batch_id=?`,
      )
      .get(id) as { unfinished: number | null; failed: number | null };
    if (!counts.unfinished)
      this.db
        .prepare(
          "UPDATE wa_dialogue_sync_batches SET status=?,completed_at=?,reason=NULL WHERE id=? AND status='RUNNING'",
        )
        .run(counts.failed ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED', this.now(), id);
  }
  private schedule(id: string): void {
    const batch = this.row(id);
    if (batch.status !== 'RUNNING') return;
    if (
      this.db
        .prepare("SELECT 1 FROM wa_dialogue_sync_batch_items WHERE batch_id=? AND status='ACTIVE'")
        .get(id)
    )
      return;
    const rows = this.db
      .prepare(
        "SELECT * FROM wa_dialogue_sync_batch_items WHERE batch_id=? AND status='WAITING' ORDER BY position",
      )
      .all(id) as Item[];
    const reviews = new ConversationReviewRepository(this.db);
    for (const item of rows) {
      const mode = new OperationsRepository(this.db).policy(item.conversation_id).batchMode;
      if (mode !== 'INCLUDE') {
        this.db
          .prepare(
            "UPDATE wa_dialogue_sync_batch_items SET status='SKIPPED',code=? WHERE batch_id=? AND position=?",
          )
          .run(`POLICY_${mode}`, id, item.position);
        continue;
      }
      const pending = this.db
        .prepare(
          'SELECT 1 FROM wa_conversation_reviews WHERE conversation_id=? AND revision>acknowledged_revision',
        )
        .get(item.conversation_id);
      if (!pending) {
        this.db
          .prepare(
            "UPDATE wa_dialogue_sync_batch_items SET status='SKIPPED',code='NO_LONGER_PENDING' WHERE batch_id=? AND position=?",
          )
          .run(id, item.position);
        continue;
      }
      const ref = reviews.reference(item.conversation_id);
      if (ref.account_id !== batch.account_id) {
        this.db
          .prepare(
            "UPDATE wa_dialogue_sync_batches SET status='PAUSED',reason='ACCOUNT_MISMATCH',paused_position=? WHERE id=?",
          )
          .run(item.position, id);
        return;
      }
      try {
        const input = DialogueSyncBatchRequestSchema.parse(JSON.parse(batch.payload_json));
        const child = new DialogueSyncRepository(this.db, this.now).create({
          query: item.query,
          conversationId: item.conversation_id,
          accountId: batch.account_id,
          limit: input.limitPerConversation,
          idempotencyKey: `batch:${id}:${item.position}:${item.attempts + 1}`,
        });
        this.db
          .prepare(
            "UPDATE wa_dialogue_sync_batch_items SET status='ACTIVE',sync_request_id=?,attempts=attempts+1,code=NULL WHERE batch_id=? AND position=?",
          )
          .run(child.id, id, item.position);
        return;
      } catch (error) {
        const code = error instanceof Error ? error.message : 'SYNC_FAILED';
        this.db
          .prepare(
            "UPDATE wa_dialogue_sync_batches SET status='PAUSED',reason=?,paused_position=? WHERE id=?",
          )
          .run(code.startsWith('SYNC_') ? code : 'SYNC_FAILED', item.position, id);
        return;
      }
    }
    this.finish(id);
  }
  advance(): void {
    this.db
      .transaction(() => {
        this.refresh();
        const rows = this.db
          .prepare("SELECT id FROM wa_dialogue_sync_batches WHERE status='RUNNING'")
          .all() as Array<{ id: string }>;
        for (const row of rows) this.schedule(row.id);
      })
      .immediate();
  }
  get(id: string) {
    return this.db
      .transaction(() => {
        this.row(id);
        this.refresh(id);
        this.finish(id);
        const batch = this.row(id);
        const counts = this.db
          .prepare(
            `SELECT COUNT(*) total,SUM(status='WAITING') waiting,SUM(status='ACTIVE') active,
        SUM(status='SUCCEEDED') succeeded,SUM(status='FAILED') failed,SUM(status='SKIPPED') skipped,SUM(status='CANCELLED') cancelled,
        MIN(CASE WHEN status='ACTIVE' THEN position END) currentPosition FROM wa_dialogue_sync_batch_items WHERE batch_id=?`,
          )
          .get(id) as Record<string, number | null>;
        return DialogueSyncBatchStatusSchema.parse({
          id,
          accountId: batch.account_id,
          status: batch.status,
          total: counts.total,
          waiting: counts.waiting ?? 0,
          active: counts.active ?? 0,
          succeeded: counts.succeeded ?? 0,
          failed: counts.failed ?? 0,
          skipped: counts.skipped ?? 0,
          cancelled: counts.cancelled ?? 0,
          currentPosition:
            counts.currentPosition ?? (batch.status === 'PAUSED' ? batch.paused_position : null),
          reason: batch.reason,
          createdAt: batch.created_at,
          expiresAt: batch.expires_at,
          completedAt: batch.completed_at,
          scope: 'VISIBLE_RENDERED_ONLY',
          complete: false,
        });
      })
      .immediate();
  }
  page(id: string, raw: unknown) {
    const input = DialogueSyncBatchPageQuerySchema.parse(raw);
    const batch = this.get(id);
    const rows = this.db
      .prepare(
        `SELECT position,conversation_id conversationId,query,status,sync_request_id syncRequestId,attempts,code
      FROM wa_dialogue_sync_batch_items WHERE batch_id=? AND position>=? ORDER BY position LIMIT ?`,
      )
      .all(id, input.cursor ?? 0, input.limit + 1) as Array<{ position: number }>;
    const items = rows.slice(0, input.limit);
    return DialogueSyncBatchPageSchema.parse({
      batch,
      items,
      nextCursor: rows.length > input.limit ? items.at(-1)!.position + 1 : null,
    });
  }
  report(id: string, raw: unknown) {
    const page = this.page(id, raw);
    return DialogueSyncBatchReportSchema.parse({
      ...page,
      pendingRemaining: (
        this.db
          .prepare(
            'SELECT COUNT(*) n FROM wa_dialogue_sync_batch_items b JOIN wa_conversation_reviews r ON r.conversation_id=b.conversation_id WHERE b.batch_id=? AND r.revision>r.acknowledged_revision',
          )
          .get(id) as { n: number }
      ).n,
      readConfirmed: false,
    });
  }
  retryFailed(id: string, raw: unknown) {
    const input = RetryBatchFailuresSchema.parse(raw);
    return new OperationsRepository(this.db).replay(
      input.idempotencyKey,
      { operation: 'RETRY_FAILED', id, input },
      () => {
        const source = this.get(id);
        if (['RUNNING', 'PAUSED'].includes(source.status)) throw Error('BATCH_NOT_TERMINAL');
        const ids = (
          this.db
            .prepare(
              "SELECT conversation_id id FROM wa_dialogue_sync_batch_items WHERE batch_id=? AND status='FAILED' ORDER BY position",
            )
            .all(id) as Array<{ id: string }>
        ).map((r) => r.id);
        if (!ids.length) throw Error('NO_FAILED_ITEMS');
        return this.create({
          scope: 'SELECTED',
          conversationIds: ids,
          accountId: source.accountId ?? undefined,
          explicitAuthorization: true,
          idempotencyKey: input.idempotencyKey,
          limitPerConversation: 50,
        });
      },
      (batchId) => new DialogueSyncBatchRepository(this.db, this.now).get(batchId),
    );
  }
  private stop(id: string, status: 'CANCELLED' | 'EXPIRED'): void {
    new DialogueSyncRepository(this.db, this.now).cancelBatchJobs(id);
    this.db
      .prepare(
        "UPDATE wa_dialogue_sync_batch_items SET status='CANCELLED',code=? WHERE batch_id=? AND status IN ('WAITING','ACTIVE')",
      )
      .run(status, id);
    this.db
      .prepare('UPDATE wa_dialogue_sync_batches SET status=?,reason=?,completed_at=? WHERE id=?')
      .run(status, status, this.now(), id);
  }
  cancel(id: string, raw: unknown) {
    DialogueSyncBatchActionSchema.parse(raw);
    return this.db
      .transaction(() => {
        const current = this.get(id);
        if (['RUNNING', 'PAUSED'].includes(current.status)) {
          this.stop(id, 'CANCELLED');
          this.audit(id, 'dialogue.batch-cancelled', {});
        }
        return this.get(id);
      })
      .immediate();
  }
  resume(id: string, raw: unknown) {
    const input = DialogueSyncBatchResumeSchema.parse(raw);
    return this.db
      .transaction(() => {
        const current = this.get(id);
        if (current.status !== 'PAUSED') throw new Error('BATCH_NOT_PAUSED');
        if (this.busy(id)) throw new Error('BATCH_BUSY');
        if (input.retryFailedItem && current.currentPosition !== null)
          this.db
            .prepare(
              "UPDATE wa_dialogue_sync_batch_items SET status='WAITING',code=NULL WHERE batch_id=? AND position=? AND status='FAILED'",
            )
            .run(id, current.currentPosition);
        this.db
          .prepare(
            "UPDATE wa_dialogue_sync_batches SET status='RUNNING',reason=NULL,paused_position=NULL,run_token=? WHERE id=?",
          )
          .run(randomUUID(), id);
        this.audit(id, 'dialogue.batch-resumed', { retryFailedItem: input.retryFailedItem });
        this.schedule(id);
        return this.get(id);
      })
      .immediate();
  }
  manifest(requestId: string) {
    const item = this.db
      .prepare(
        "SELECT * FROM wa_dialogue_sync_batch_items WHERE sync_request_id=? AND status='ACTIVE'",
      )
      .get(requestId) as Item | undefined;
    if (!item) return undefined;
    const ids = this.db
      .prepare(
        'SELECT conversation_id id FROM wa_dialogue_sync_batch_items WHERE batch_id=? ORDER BY position',
      )
      .all(item.batch_id) as Array<{ id: string }>;
    return {
      id: item.batch_id,
      runToken: this.row(item.batch_id).run_token,
      position: item.position,
      total: ids.length,
      conversationIds: ids.map((r) => r.id),
    };
  }
  private audit(id: string, action: string, metadata: Record<string, unknown>) {
    this.db
      .prepare(
        `INSERT INTO wa_audit_log(id,actor_type,actor_id,action,resource_type,resource_id,at,outcome,correlation_id,metadata_json)
      VALUES(?,'USER','local-api-principal',?,'dialogue-sync-batch',?,?,'SUCCESS',?,?)`,
      )
      .run(randomUUID(), action, id, this.now(), id, JSON.stringify(metadata));
  }
}
