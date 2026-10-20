import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  ConversationReviewAckSchema,
  ConversationReviewLinkSchema,
  ConversationReviewItemSchema,
  ConversationReviewPageSchema,
  ConversationReviewQuerySchema,
  type CaptureObservation,
} from '@wai-bridge/shared';

type Review = {
  conversation_id: string;
  revision: number;
  verified_revision: number;
  acknowledged_revision: number;
  signal_count: number;
  unread_count: number | null;
  unread_observed_at: string | null;
  last_activity_at: string;
  last_sync_request_id: string | null;
  last_sync_at: string | null;
  last_read_confirmed_at: string | null;
};
type Reference = {
  id: string;
  title: string | null;
  kind: string;
  account_id: string | null;
  phone: string | null;
};

export class ConversationReviewRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly now = () => new Date().toISOString(),
  ) {}

  reference(id: string): Reference {
    z.uuid().parse(id);
    const row = this.db
      .prepare(
        `SELECT c.id,c.title,c.kind,i.account_id,p.phone_number phone
      FROM wa_conversations c LEFT JOIN wa_conversation_identities i ON i.conversation_id=c.id
      LEFT JOIN wa_contacts p ON p.id=i.peer_contact_id WHERE c.id=?`,
      )
      .get(id) as Reference | undefined;
    if (!row) throw new Error('REVIEW_NOT_FOUND');
    return row;
  }

  signal(conversationId: string, observation: CaptureObservation): void {
    if (
      observation.observationType !== 'CONVERSATION_ACTIVITY' &&
      observation.direction !== 'INBOUND'
    )
      return;
    if (observation.activity?.reason === 'UNREAD_DECREASED') {
      this.db
        .prepare(
          `UPDATE wa_conversation_reviews SET unread_count=?,unread_observed_at=?
        WHERE conversation_id=? AND (unread_observed_at IS NULL OR unread_observed_at<=?)`,
        )
        .run(
          observation.activity.unreadCount,
          observation.observedAt,
          conversationId,
          observation.observedAt,
        );
      return;
    }
    if (
      this.db
        .prepare('SELECT 1 FROM wa_conversation_review_signals WHERE observation_id=?')
        .get(observation.observationId)
    )
      return;
    const unread = observation.activity?.unreadCount;
    this.db
      .prepare(
        `INSERT INTO wa_conversation_reviews(conversation_id,revision,signal_count,unread_count,unread_observed_at,last_activity_at)
      VALUES(?,1,1,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET
      revision=revision+1,signal_count=signal_count+1,
      unread_count=CASE WHEN excluded.unread_observed_at IS NOT NULL AND (unread_observed_at IS NULL OR excluded.unread_observed_at>=unread_observed_at) THEN excluded.unread_count ELSE unread_count END,
      unread_observed_at=CASE WHEN excluded.unread_observed_at IS NOT NULL AND (unread_observed_at IS NULL OR excluded.unread_observed_at>=unread_observed_at) THEN excluded.unread_observed_at ELSE unread_observed_at END,
      last_activity_at=MAX(last_activity_at,excluded.last_activity_at)`,
      )
      .run(
        conversationId,
        unread ?? null,
        unread === undefined ? null : observation.observedAt,
        observation.observedAt,
      );
    const row = this.row(conversationId)!;
    this.db
      .prepare(
        'INSERT INTO wa_conversation_review_signals(observation_id,conversation_id,revision) VALUES(?,?,?)',
      )
      .run(observation.observationId, conversationId, row.revision);
  }

  private row(id: string): Review | undefined {
    return this.db
      .prepare('SELECT * FROM wa_conversation_reviews WHERE conversation_id=?')
      .get(id) as Review | undefined;
  }

  findUniqueTarget(query: string, accountId?: string): string | undefined {
    const rows = this.db
      .prepare(
        `SELECT r.conversation_id id FROM wa_conversation_reviews r
      JOIN wa_conversations c ON c.id=r.conversation_id
      JOIN wa_conversation_identities i ON i.conversation_id=c.id
      LEFT JOIN wa_contacts p ON p.id=i.peer_contact_id
      WHERE (? IS NULL OR i.account_id=?) AND (c.title=? COLLATE NOCASE OR p.phone_number=?) LIMIT 2`,
      )
      .all(
        accountId ?? null,
        accountId ?? null,
        query.normalize('NFC').trim(),
        query.trim(),
      ) as Array<{ id: string }>;
    return rows.length === 1 ? rows[0]!.id : undefined;
  }

  compatible(a: string, b: string): boolean {
    if (a === b) return true;
    const left = this.reference(a),
      right = this.reference(b);
    if (!left.account_id || left.account_id !== right.account_id) return false;
    if (left.kind !== 'UNKNOWN' && right.kind !== 'UNKNOWN' && left.kind !== right.kind)
      return false;
    if (left.phone && right.phone && left.phone !== right.phone) return false;
    if (
      left.phone &&
      left.phone === right.phone &&
      left.kind === 'DIRECT' &&
      right.kind === 'DIRECT'
    )
      return true;
    return Boolean(
      this.db
        .prepare(
          'SELECT 1 FROM wa_conversation_review_links WHERE conversation_id=? AND related_conversation_id=?',
        )
        .get(a, b),
    );
  }

  link(id: string, raw: unknown) {
    const input = ConversationReviewLinkSchema.parse(raw);
    return this.db
      .transaction(() => {
        const left = this.reference(id),
          right = this.reference(input.relatedConversationId);
        if (
          id === right.id ||
          !left.account_id ||
          left.account_id !== right.account_id ||
          (left.kind !== 'UNKNOWN' && right.kind !== 'UNKNOWN' && left.kind !== right.kind) ||
          (left.phone && right.phone && left.phone !== right.phone)
        )
          throw new Error('REVIEW_IDENTITY_CONFLICT');
        let changes = 0;
        for (const [a, b] of [
          [id, right.id],
          [right.id, id],
        ])
          changes += this.db
            .prepare(
              'INSERT OR IGNORE INTO wa_conversation_review_links(conversation_id,related_conversation_id,created_at) VALUES(?,?,?)',
            )
            .run(a, b, this.now()).changes;
        if (changes)
          this.audit(id, 'conversation.review-linked', { relatedConversationId: right.id });
        return {
          conversationId: id,
          relatedConversationId: right.id,
          linked: true,
          historiesMerged: false,
        };
      })
      .immediate();
  }

  related(id: string): string[] {
    const ref = this.reference(id);
    const ids = this.db
      .prepare(
        `SELECT related_conversation_id id FROM wa_conversation_review_links WHERE conversation_id=?
      UNION SELECT i.conversation_id id FROM wa_conversation_identities i JOIN wa_contacts p ON p.id=i.peer_contact_id
      JOIN wa_conversations c ON c.id=i.conversation_id WHERE i.account_id=? AND p.phone_number=? AND c.kind='DIRECT' AND i.conversation_id<>? ORDER BY id`,
      )
      .all(id, ref.account_id, ref.kind === 'DIRECT' ? ref.phone : null, id) as Array<{
      id: string;
    }>;
    return ids.map((r) => r.id);
  }

  get(id: string) {
    const ref = this.reference(id),
      row = this.row(id);
    if (!row) throw new Error('REVIEW_NOT_FOUND');
    const job = row.last_sync_request_id
      ? (this.db
          .prepare(
            'SELECT status,expires_at,result_json,review_revision FROM wa_dialogue_sync_requests WHERE id=?',
          )
          .get(row.last_sync_request_id) as
          | {
              status: string;
              expires_at: string;
              result_json: string | null;
              review_revision: number | null;
            }
          | undefined)
      : undefined;
    const status =
      job && ['REQUESTED', 'CLAIMED'].includes(job.status) && job.expires_at <= this.now()
        ? 'EXPIRED'
        : job?.status;
    const pending = row.revision > row.acknowledged_revision;
    const newerSignal =
      job?.review_revision !== null &&
      job?.review_revision !== undefined &&
      row.revision > job.review_revision;
    const stage = !pending
      ? 'READ_CONFIRMED'
      : status === 'REQUESTED'
        ? 'SYNC_REQUESTED'
        : status === 'CLAIMED'
          ? 'SYNCING'
          : newerSignal
            ? 'WAITING_SYNC'
            : status === 'FAILED'
              ? 'SYNC_FAILED'
              : status === 'EXPIRED'
                ? 'SYNC_EXPIRED'
                : row.verified_revision >= row.revision
                  ? 'SYNCED_PARTIAL'
                  : 'WAITING_SYNC';
    const result = job?.result_json
      ? (JSON.parse(job.result_json) as { code?: string })
      : undefined;
    return ConversationReviewItemSchema.parse({
      conversationId: id,
      accountId: ref.account_id,
      title: ref.title,
      kind: ref.kind,
      phone: ref.phone,
      identityContinuity: 'REFERENCE_ONLY',
      relatedConversationIds: this.related(id),
      stage,
      pending,
      revision: row.revision,
      verifiedRevision: row.verified_revision,
      acknowledgedRevision: row.acknowledged_revision,
      signalCount: row.signal_count,
      unreadCountObserved: row.unread_count,
      unreadObservedAt: row.unread_observed_at,
      lastActivityAt: row.last_activity_at,
      lastSyncRequestId: row.last_sync_request_id,
      lastSyncAt: row.last_sync_at,
      lastError:
        status === 'EXPIRED'
          ? 'TIMEOUT'
          : status === 'FAILED'
            ? (result?.code ?? 'SYNC_FAILED')
            : null,
      lastReadConfirmedAt: row.last_read_confirmed_at,
      complete: false,
      signalsAreNotMessageCounts: true,
    });
  }

  list(raw: unknown) {
    const input = ConversationReviewQuerySchema.parse(raw);
    const cte = `WITH queue AS (
      SELECT r.conversation_id,r.revision,r.acknowledged_revision,c.title,i.account_id,
        CASE
          WHEN r.revision<=r.acknowledged_revision THEN 'READ_CONFIRMED'
          WHEN j.status IN ('REQUESTED','CLAIMED') AND j.expires_at>? THEN
            CASE j.status WHEN 'REQUESTED' THEN 'SYNC_REQUESTED' ELSE 'SYNCING' END
          WHEN j.review_revision IS NOT NULL AND r.revision>j.review_revision THEN 'WAITING_SYNC'
          WHEN j.status='EXPIRED' OR (j.status IN ('REQUESTED','CLAIMED') AND j.expires_at<=?) THEN 'SYNC_EXPIRED'
          WHEN j.status='FAILED' THEN 'SYNC_FAILED'
          WHEN r.verified_revision>=r.revision THEN 'SYNCED_PARTIAL'
          ELSE 'WAITING_SYNC' END stage
      FROM wa_conversation_reviews r JOIN wa_conversations c ON c.id=r.conversation_id
      LEFT JOIN wa_conversation_identities i ON i.conversation_id=c.id
      LEFT JOIN wa_dialogue_sync_requests j ON j.id=r.last_sync_request_id
    ), filtered AS (
      SELECT * FROM queue WHERE (? IS NULL OR account_id=?)
      AND (?='false' OR revision>acknowledged_revision)
      AND (? IS NULL OR instr(lower(COALESCE(title,'')),lower(?))>0)
      AND (? IS NULL OR stage=?)
    )`;
    const params = [
      this.now(),
      this.now(),
      input.accountId ?? null,
      input.accountId ?? null,
      input.pendingOnly,
      input.query ?? null,
      input.query ?? null,
      input.stage ?? null,
      input.stage ?? null,
    ];
    const total = (
      this.db.prepare(cte + ' SELECT COUNT(*) n FROM filtered').get(...params) as { n: number }
    ).n;
    const rows = this.db
      .prepare(
        cte +
          ` SELECT conversation_id id FROM filtered
      WHERE (? IS NULL OR conversation_id>?) ORDER BY conversation_id LIMIT ?`,
      )
      .all(...params, input.cursor ?? null, input.cursor ?? null, input.limit + 1) as Array<{
      id: string;
    }>;
    const more = rows.length > input.limit;
    const items = rows.slice(0, input.limit).map((r) => this.get(r.id));
    return ConversationReviewPageSchema.parse({
      items,
      total,
      nextCursor: more ? items.at(-1)!.conversationId : null,
      scope: 'OBSERVED_UI_ONLY',
      complete: false,
    });
  }

  requested(id: string, jobId: string): void {
    this.db
      .prepare('UPDATE wa_conversation_reviews SET last_sync_request_id=? WHERE conversation_id=?')
      .run(jobId, id);
  }
  revision(id: string): number {
    return this.row(id)?.revision ?? 0;
  }
  completed(id: string, jobId: string, revision: number): void {
    this.db
      .prepare(
        `UPDATE wa_conversation_reviews SET verified_revision=MAX(verified_revision,?),last_sync_at=?
      WHERE conversation_id=? AND last_sync_request_id=?`,
      )
      .run(revision, this.now(), id, jobId);
  }
  acknowledge(id: string, raw: unknown) {
    const input = ConversationReviewAckSchema.parse(raw);
    return this.db
      .transaction(() => {
        const current = this.get(id);
        const succeeded = this.db
          .prepare("SELECT 1 FROM wa_dialogue_sync_requests WHERE id=? AND status='SUCCEEDED'")
          .get(input.syncRequestId);
        if (
          !succeeded ||
          current.lastSyncRequestId !== input.syncRequestId ||
          current.revision !== input.revision ||
          current.verifiedRevision !== input.revision ||
          !['SYNCED_PARTIAL', 'READ_CONFIRMED'].includes(current.stage)
        )
          throw new Error('REVIEW_STALE_CONFIRMATION');
        if (current.pending) {
          this.db
            .prepare(
              'UPDATE wa_conversation_reviews SET acknowledged_revision=?,last_read_confirmed_at=? WHERE conversation_id=?',
            )
            .run(input.revision, this.now(), id);
          this.audit(id, 'conversation.review-read-confirmed', {
            syncRequestId: input.syncRequestId,
            revision: input.revision,
          });
        }
        return this.get(id);
      })
      .immediate();
  }
  private audit(id: string, action: string, metadata: Record<string, unknown>): void {
    this.db
      .prepare(
        `INSERT INTO wa_audit_log(id,actor_type,actor_id,action,resource_type,resource_id,at,outcome,correlation_id,metadata_json)
      VALUES(?,'USER','local-api-principal',?,'conversation',?,?,'SUCCESS',?,?)`,
      )
      .run(randomUUID(), action, id, this.now(), randomUUID(), JSON.stringify(metadata));
  }
}
