import type Database from 'better-sqlite3';
import { MessageInsertSchema, type MessageInsert } from '../schemas.js';
export interface MessageRow extends MessageInsert {
  readonly created_at: string;
}
export class MessageRepository {
  constructor(private readonly db: Database.Database) {}
  insert(input: MessageInsert): { readonly inserted: boolean; readonly id: string } {
    const value = MessageInsertSchema.parse(input);
    const insertTransaction = this.db.transaction(() => {
      const result = this.db
        .prepare(
          `INSERT OR IGNORE INTO wa_messages(id,conversation_id,sender_contact_id,external_id,direction,capture_status,content,content_availability,observed_at,captured_at,sequence,idempotency_scope,idempotency_key,created_at) VALUES(@id,@conversationId,@senderContactId,@externalId,@direction,@captureStatus,@content,@contentAvailability,@observedAt,@capturedAt,@sequence,@idempotencyScope,@idempotencyKey,@createdAt)`,
        )
        .run({
          ...value,
          senderContactId: value.senderContactId ?? null,
          externalId: value.externalId ?? null,
          content: value.content ?? null,
          capturedAt: value.capturedAt ?? null,
          idempotencyScope: value.idempotencyScope ?? null,
          idempotencyKey: value.idempotencyKey ?? null,
          createdAt: value.observedAt,
        });
      if (result.changes === 0) {
        const existing = value.idempotencyKey
          ? (this.db
              .prepare('SELECT id FROM wa_messages WHERE idempotency_scope=? AND idempotency_key=?')
              .get(value.idempotencyScope, value.idempotencyKey) as { id: string } | undefined)
          : undefined;
        const byExternal = value.externalId
          ? (this.db
              .prepare('SELECT id FROM wa_messages WHERE conversation_id=? AND external_id=?')
              .get(value.conversationId, value.externalId) as { id: string } | undefined)
          : undefined;
        const sameId = this.db.prepare('SELECT id FROM wa_messages WHERE id=?').get(value.id) as
          { id: string } | undefined;
        const found = existing ?? byExternal ?? sameId;
        if (found) return { inserted: false, id: found.id };
        throw new Error('Message insert conflicted with a unique constraint');
      }
      this.db
        .prepare(
          "INSERT INTO wa_ai_message_state(message_id,state,updated_at) VALUES(?,'UNREAD',?)",
        )
        .run(value.id, value.observedAt);
      return { inserted: true, id: value.id };
    });
    return insertTransaction.immediate();
  }
  getById(id: string): MessageRow | undefined {
    return this.db
      .prepare(
        'SELECT *, (SELECT state FROM wa_ai_message_state s WHERE s.message_id=m.id) AS ai_state FROM wa_messages m WHERE id=?',
      )
      .get(id) as MessageRow | undefined;
  }
  listRecent(
    options: {
      readonly beforeSequence?: number;
      readonly limit?: number;
      readonly conversationId?: string;
    } = {},
  ): readonly MessageRow[] {
    const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 50)));
    if (options.conversationId)
      return this.db
        .prepare(
          'SELECT * FROM wa_messages WHERE conversation_id=? AND (? IS NULL OR sequence < ?) ORDER BY sequence DESC,id DESC LIMIT ?',
        )
        .all(
          options.conversationId,
          options.beforeSequence ?? null,
          options.beforeSequence ?? null,
          limit,
        ) as MessageRow[];
    return this.db
      .prepare(
        'SELECT * FROM wa_messages WHERE (? IS NULL OR sequence < ?) ORDER BY sequence DESC,id DESC LIMIT ?',
      )
      .all(options.beforeSequence ?? null, options.beforeSequence ?? null, limit) as MessageRow[];
  }
  search(query: string, limit = 50): readonly { message_id: string; content: string }[] {
    return this.db
      .prepare(
        `SELECT message_id, snippet(wa_messages_fts,1,'<','>','…',12) AS content FROM wa_messages_fts WHERE wa_messages_fts MATCH ? LIMIT ?`,
      )
      .all(query, Math.min(100, Math.max(1, limit))) as { message_id: string; content: string }[];
  }
}
