import { CaptureCoverageSchema, CaptureMediaSummarySchema } from '@wai-bridge/shared';
import type Database from 'better-sqlite3';
export interface PageOptions {
  readonly messageIds?: readonly string[];
  readonly afterId?: string | undefined;
  readonly afterSequence?: number | undefined;
  readonly afterObservedAt?: string | undefined;
  readonly beforeId?: string | undefined;
  readonly limit: number;
  readonly conversationId?: string | undefined;
  readonly aiState?: string | undefined;
  readonly direction?: string | undefined;
  readonly captureStatus?: string | undefined;
  readonly consumerId?: string | undefined;
}
export class ApiReadRepository {
  constructor(private readonly db: Database.Database) {}
  captureCoverage(conversationId: string) {
    const messages = this.db
      .prepare(
        "SELECT COUNT(*) messageCount,COALESCE(SUM(content_availability<>'AVAILABLE'),0) unavailableMessageCount,MAX(observed_at) lastMessageAt FROM wa_messages WHERE conversation_id=?",
      )
      .get(conversationId) as Record<string, unknown>;
    const activity = this.db
      .prepare(
        "SELECT COUNT(*) activitySignalCount,MAX(o.observed_at) lastActivityAt FROM wa_capture_normalizations n JOIN wa_capture_observations o ON o.id=n.observation_id WHERE n.conversation_id=? AND o.observation_type='CONVERSATION_ACTIVITY'",
      )
      .get(conversationId) as { activitySignalCount: number; lastActivityAt: string | null };
    const unknown = this.db
      .prepare(
        "SELECT COUNT(*) count FROM wa_capture_normalizations WHERE conversation_id=? AND status='DIRECTION_UNKNOWN'",
      )
      .get(conversationId) as { count: number };
    const recentActivity = this.db
      .prepare(
        "SELECT o.id observationId,o.observed_at observedAt FROM wa_capture_normalizations n JOIN wa_capture_observations o ON o.id=n.observation_id WHERE n.conversation_id=? AND o.observation_type='CONVERSATION_ACTIVITY' ORDER BY o.observed_at DESC,o.rowid DESC LIMIT 20",
      )
      .all(conversationId);
    return CaptureCoverageSchema.parse({
      conversationId,
      scope: 'OBSERVED_UI_ONLY',
      complete: false,
      ...messages,
      ...activity,
      unavailableMediaCount: (
        this.db
          .prepare(
            "SELECT COUNT(*) n FROM wa_media md JOIN wa_messages m ON m.id=md.message_id WHERE m.conversation_id=? AND md.availability<>'AVAILABLE'",
          )
          .get(conversationId) as { n: number }
      ).n,
      unknownDirectionObservationCount: unknown.count,
      recentActivity,
      recentActivityTruncated: activity.activitySignalCount > 20,
      activitySignalsAreNotMessages: true,
    });
  }
  contact(id: string): unknown {
    return this.db
      .prepare(
        'SELECT id,external_id AS externalId,connector,display_name AS displayName,phone_number AS phoneNumber,identity_status AS identityStatus FROM wa_contacts WHERE id=?',
      )
      .get(id);
  }
  contacts(afterId: string | undefined, limit: number): readonly unknown[] {
    return this.db
      .prepare(
        'SELECT id,external_id AS externalId,connector,display_name AS displayName,phone_number AS phoneNumber,identity_status AS identityStatus,created_at AS createdAt,updated_at AS updatedAt FROM wa_contacts WHERE (? IS NULL OR id>?) ORDER BY id LIMIT ?',
      )
      .all(afterId ?? null, afterId ?? null, limit);
  }
  searchContacts(query: string, afterId: string | undefined, limit: number): readonly unknown[] {
    const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
    return this.db
      .prepare(
        "SELECT id,external_id AS externalId,connector,display_name AS displayName,phone_number AS phoneNumber,identity_status AS identityStatus FROM wa_contacts WHERE (display_name LIKE ? ESCAPE '\\' OR external_id LIKE ? ESCAPE '\\' OR phone_number LIKE ? ESCAPE '\\') AND (? IS NULL OR id>?) ORDER BY id LIMIT ?",
      )
      .all(pattern, pattern, pattern, afterId ?? null, afterId ?? null, limit);
  }
  conversations(afterId: string | undefined, limit: number, query?: string): readonly unknown[] {
    const pattern = query ? `%${query.replace(/[\\%_]/g, '\\$&')}%` : null;
    return this.db
      .prepare(
        `SELECT c.id,c.external_id AS externalId,c.connector,c.kind,c.title,c.created_at AS createdAt,c.updated_at AS updatedAt,
        n.observation_id AS sourceObservationId, CASE WHEN i.conversation_id IS NOT NULL THEN 'PARTIAL' WHEN n.observation_id IS NOT NULL THEN 'UNKNOWN' ELSE NULL END AS identityStatus, i.account_id AS localAccountId, i.source AS identitySource, p.display_name AS contactName,p.phone_number AS contactPhone,CASE WHEN c.kind='GROUP' THEN c.title ELSE NULL END AS groupName
        FROM wa_conversations c LEFT JOIN (SELECT conversation_id, MIN(observation_id) observation_id FROM wa_capture_normalizations GROUP BY conversation_id) n ON n.conversation_id=c.id LEFT JOIN wa_conversation_identities i ON i.conversation_id=c.id LEFT JOIN wa_contacts p ON p.id=i.peer_contact_id
        WHERE (? IS NULL OR c.id>?) AND (? IS NULL OR c.title LIKE ? ESCAPE '\\') ORDER BY c.id LIMIT ?`,
      )
      .all(afterId ?? null, afterId ?? null, pattern, pattern, limit);
  }
  conversation(id: string): unknown {
    return this.db
      .prepare(
        `SELECT c.id,c.external_id AS externalId,c.connector,c.kind,c.title,c.created_at AS createdAt,c.updated_at AS updatedAt,
        n.observation_id AS sourceObservationId, CASE WHEN i.conversation_id IS NOT NULL THEN 'PARTIAL' WHEN n.observation_id IS NOT NULL THEN 'UNKNOWN' ELSE NULL END AS identityStatus, i.account_id AS localAccountId, i.source AS identitySource, p.display_name AS contactName,p.phone_number AS contactPhone,CASE WHEN c.kind='GROUP' THEN c.title ELSE NULL END AS groupName
        FROM wa_conversations c LEFT JOIN (SELECT conversation_id, MIN(observation_id) observation_id FROM wa_capture_normalizations GROUP BY conversation_id) n ON n.conversation_id=c.id LEFT JOIN wa_conversation_identities i ON i.conversation_id=c.id LEFT JOIN wa_contacts p ON p.id=i.peer_contact_id WHERE c.id=?`,
      )
      .get(id);
  }
  messages(options: PageOptions): readonly unknown[] {
    const clauses: string[] = [];
    const params: (string | number | null)[] = [];
    if (options.messageIds) {
      if (!options.messageIds.length) return [];
      clauses.push(`m.id IN (${options.messageIds.map(() => '?').join(',')})`);
      params.push(...options.messageIds);
    }
    if (options.conversationId) {
      clauses.push('m.conversation_id=?');
      params.push(options.conversationId);
    }
    if (options.aiState) {
      clauses.push(options.consumerId ? "COALESCE(cs.state,'UNREAD')=?" : 's.state=?');
      params.push(options.aiState);
    }
    if (options.direction) {
      clauses.push('m.direction=?');
      params.push(options.direction);
    }
    if (options.captureStatus) {
      clauses.push('m.capture_status=?');
      params.push(options.captureStatus);
    }
    let ordering = 'm.observed_at DESC,m.id DESC';
    if (options.conversationId) {
      ordering = 'm.sequence DESC,m.id DESC';
      if (options.afterSequence !== undefined) {
        clauses.push('m.sequence<?');
        params.push(options.afterSequence);
      }
    } else if (options.afterObservedAt !== undefined && options.beforeId !== undefined) {
      clauses.push('(m.observed_at<? OR (m.observed_at=? AND m.id<?))');
      params.push(options.afterObservedAt, options.afterObservedAt, options.beforeId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const stateJoin = options.consumerId
      ? 'LEFT JOIN wa_ai_consumer_message_state cs ON cs.message_id=m.id AND cs.consumer_id=?'
      : '';
    if (options.consumerId) params.unshift(options.consumerId);
    const stateSelect = options.consumerId ? "COALESCE(cs.state,'UNREAD')" : 's.state';
    const rows = this.db
      .prepare(
        `SELECT m.id,m.conversation_id AS conversationId,m.sender_contact_id AS senderContactId,m.external_id AS externalId,m.direction,m.capture_status AS captureStatus,m.content,m.content_availability AS contentAvailability,m.observed_at AS observedAt,m.captured_at AS capturedAt,m.sequence,${stateSelect} AS aiState,
        n.observation_id AS sourceObservationId, CASE WHEN i.conversation_id IS NOT NULL THEN 'PARTIAL' WHEN n.observation_id IS NOT NULL THEN 'UNKNOWN' ELSE NULL END AS identityStatus, i.account_id AS localAccountId, i.source AS identitySource, p.display_name AS contactName,p.phone_number AS contactPhone,CASE WHEN c.kind='GROUP' THEN c.title ELSE NULL END AS groupName,
        (SELECT COUNT(*) FROM wa_media md WHERE md.message_id=m.id) mediaCount,
        (SELECT json_group_array(json_object('id',md.id,'kind',md.media_type,'availability',md.availability,'processingStatus',md.processing_status)) FROM (SELECT id,media_type,availability,processing_status FROM wa_media WHERE message_id=m.id ORDER BY id LIMIT 16) md) mediaJson
        FROM wa_messages m JOIN wa_ai_message_state s ON s.message_id=m.id
        LEFT JOIN wa_capture_normalizations n ON n.observation_id=(SELECT nn.observation_id FROM wa_capture_normalizations nn WHERE nn.message_id=m.id ORDER BY nn.rowid DESC LIMIT 1) LEFT JOIN wa_conversation_identities i ON i.conversation_id=m.conversation_id LEFT JOIN wa_contacts p ON p.id=i.peer_contact_id JOIN wa_conversations c ON c.id=m.conversation_id ${stateJoin} ${where} ORDER BY ${ordering} LIMIT ?`,
      )
      .all(...params, options.limit) as Array<
      Record<string, unknown> & { mediaJson: string; mediaCount: number }
    >;
    return rows.map(({ mediaJson, ...row }) => ({
      ...row,
      media: CaptureMediaSummarySchema.array().max(16).parse(JSON.parse(mediaJson)),
      mediaTruncated: row.mediaCount > 16,
    }));
  }
  media(id: string): unknown {
    return this.db
      .prepare(
        'SELECT id,message_id AS messageId,media_type AS mediaType,mime_type AS mimeType,size_bytes AS sizeBytes,sha256,availability,created_at AS createdAt FROM wa_media WHERE id=?',
      )
      .get(id);
  }
}
