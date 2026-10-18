import type Database from 'better-sqlite3';
export interface PageOptions {
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
  conversations(afterId: string | undefined, limit: number): readonly unknown[] {
    return this.db
      .prepare(
        `SELECT c.id,c.external_id AS externalId,c.connector,c.kind,c.title,c.created_at AS createdAt,c.updated_at AS updatedAt,
        n.observation_id AS sourceObservationId, CASE WHEN i.conversation_id IS NOT NULL THEN 'PARTIAL' WHEN n.observation_id IS NOT NULL THEN 'UNKNOWN' ELSE NULL END AS identityStatus, i.account_id AS localAccountId, i.source AS identitySource, p.display_name AS contactName,p.phone_number AS contactPhone,CASE WHEN c.kind='GROUP' THEN c.title ELSE NULL END AS groupName
        FROM wa_conversations c LEFT JOIN (SELECT conversation_id, MIN(observation_id) observation_id FROM wa_capture_normalizations GROUP BY conversation_id) n ON n.conversation_id=c.id LEFT JOIN wa_conversation_identities i ON i.conversation_id=c.id LEFT JOIN wa_contacts p ON p.id=i.peer_contact_id
        WHERE (? IS NULL OR c.id>?) ORDER BY c.id LIMIT ?`,
      )
      .all(afterId ?? null, afterId ?? null, limit);
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
    return this.db
      .prepare(
        `SELECT m.id,m.conversation_id AS conversationId,m.sender_contact_id AS senderContactId,m.external_id AS externalId,m.direction,m.capture_status AS captureStatus,m.content,m.content_availability AS contentAvailability,m.observed_at AS observedAt,m.captured_at AS capturedAt,m.sequence,${stateSelect} AS aiState,
        n.observation_id AS sourceObservationId, CASE WHEN i.conversation_id IS NOT NULL THEN 'PARTIAL' WHEN n.observation_id IS NOT NULL THEN 'UNKNOWN' ELSE NULL END AS identityStatus, i.account_id AS localAccountId, i.source AS identitySource, p.display_name AS contactName,p.phone_number AS contactPhone,CASE WHEN c.kind='GROUP' THEN c.title ELSE NULL END AS groupName
        FROM wa_messages m JOIN wa_ai_message_state s ON s.message_id=m.id
        LEFT JOIN wa_capture_normalizations n ON n.message_id=m.id LEFT JOIN wa_conversation_identities i ON i.conversation_id=m.conversation_id LEFT JOIN wa_contacts p ON p.id=i.peer_contact_id JOIN wa_conversations c ON c.id=m.conversation_id ${stateJoin} ${where} ORDER BY ${ordering} LIMIT ?`,
      )
      .all(...params, options.limit);
  }
  media(id: string): unknown {
    return this.db
      .prepare(
        'SELECT id,message_id AS messageId,media_type AS mediaType,mime_type AS mimeType,size_bytes AS sizeBytes,sha256,availability,created_at AS createdAt FROM wa_media WHERE id=?',
      )
      .get(id);
  }
}
