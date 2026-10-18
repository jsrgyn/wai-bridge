import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { AIMessageStateSchema, UtcTimestampSchema } from '../schemas.js';
import { z } from 'zod';

const ConsumerSchema = z.string().trim().min(1).max(128);
const LeaseMsSchema = z.number().int().min(1000).max(24 * 60 * 60 * 1000);
export interface ConsumerMessageState { messageId: string; consumerId: string; state: 'UNREAD' | 'CLAIMED' | 'READ' | 'FAILED'; version: number; leaseUntil: string | null; lastErrorCode: string | null }
export class AIMessageStateRepository {
  constructor(private readonly db: Database.Database) {}
  get(
    messageId: string,
  ): { state: 'UNREAD' | 'CLAIMED' | 'READ' | 'FAILED'; version: number } | undefined {
    const row = this.db
      .prepare('SELECT state,version FROM wa_ai_message_state WHERE message_id=?')
      .get(messageId) as { state: string; version: number } | undefined;
    if (!row) return undefined;
    return { state: AIMessageStateSchema.parse(row.state), version: row.version };
  }
  claim(
    messageId: string,
    consumerId: string,
    now: string,
  ): { state: 'CLAIMED'; claimToken: string } {
    UtcTimestampSchema.parse(now);
    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT state,claimed_by,claim_token FROM wa_ai_message_state WHERE message_id=?')
        .get(messageId) as
        { state: string; claimed_by: string | null; claim_token: string | null } | undefined;
      if (!row) throw new Error('Message state not found');
      if (row.state === 'CLAIMED' && row.claimed_by === consumerId && row.claim_token)
        return { state: 'CLAIMED' as const, claimToken: row.claim_token };
      if (row.state !== 'UNREAD') throw new Error('STATE_CONFLICT');
      const claimToken = randomUUID();
      this.db
        .prepare(
          "UPDATE wa_ai_message_state SET state='CLAIMED',claimed_by=?,claim_token=?,version=version+1,updated_at=? WHERE message_id=? AND state='UNREAD'",
        )
        .run(consumerId, claimToken, now, messageId);
      this.audit(messageId, 'UNREAD', 'CLAIMED', consumerId, now);
      return { state: 'CLAIMED' as const, claimToken };
    });
    return tx.immediate();
  }
  acknowledge(
    messageId: string,
    consumerId: string,
    claimToken: string,
    now: string,
  ): { state: 'READ' } {
    UtcTimestampSchema.parse(now);
    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT state,claimed_by,claim_token FROM wa_ai_message_state WHERE message_id=?')
        .get(messageId) as
        { state: string; claimed_by: string | null; claim_token: string | null } | undefined;
      if (!row) throw new Error('Message state not found');
      if (row.state === 'READ' && row.claimed_by === consumerId && row.claim_token === claimToken)
        return { state: 'READ' as const };
      if (
        row.state !== 'CLAIMED' ||
        row.claimed_by !== consumerId ||
        row.claim_token !== claimToken
      )
        throw new Error('ACK_FORBIDDEN');
      this.db
        .prepare(
          "UPDATE wa_ai_message_state SET state='READ',version=version+1,updated_at=? WHERE message_id=? AND state='CLAIMED'",
        )
        .run(now, messageId);
      this.audit(messageId, 'CLAIMED', 'READ', consumerId, now);
      return { state: 'READ' as const };
    });
    return tx.immediate();
  }
  private audit(messageId: string, from: string, to: string, actor: string, at: string): void {
    this.db
      .prepare(
        'INSERT INTO wa_audit_log(id,actor_type,actor_id,action,resource_type,resource_id,at,outcome,correlation_id,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        randomUUID(),
        'consumer',
        actor,
        'ai-message-state.changed',
        'message',
        messageId,
        at,
        'success',
        messageId,
        JSON.stringify({ from, to }),
      );
  }
  set(messageId: string, state: 'UNREAD' | 'CLAIMED' | 'READ' | 'FAILED', updatedAt: string): void {
    AIMessageStateSchema.parse(state);
    UtcTimestampSchema.parse(updatedAt);
    const tx = this.db.transaction(() => {
      const current = this.db
        .prepare('SELECT state FROM wa_ai_message_state WHERE message_id=?')
        .get(messageId) as { state: string } | undefined;
      if (!current) throw new Error('Message state not found');
      if (current.state === state) return;
      this.db
        .prepare(
          'UPDATE wa_ai_message_state SET state=?,version=version+1,updated_at=? WHERE message_id=?',
        )
        .run(state, updatedAt, messageId);
      this.db
        .prepare(
          'INSERT INTO wa_audit_log(id,actor_type,action,resource_type,resource_id,at,outcome,correlation_id,metadata_json) VALUES(?,?,?,?,?,?,?,?,?)',
        )
        .run(
          randomUUID(),
          'system',
          'ai-message-state.changed',
          'message',
          messageId,
          updatedAt,
          'success',
          messageId,
          JSON.stringify({ from: current.state, to: state }),
        );
    });
    tx.immediate();
  }

  getForConsumer(messageId: string, consumerId: string): ConsumerMessageState | undefined {
    const consumer = ConsumerSchema.parse(consumerId);
    const row = this.db.prepare(`SELECT message_id AS messageId,consumer_id AS consumerId,state,version,lease_until AS leaseUntil,last_error_code AS lastErrorCode
      FROM wa_ai_consumer_message_state WHERE message_id=? AND consumer_id=?`).get(z.uuid().parse(messageId), consumer) as Omit<ConsumerMessageState, 'state'> & { state: string } | undefined;
    return row ? { ...row, state: AIMessageStateSchema.parse(row.state) } : undefined;
  }

  claimForConsumer(messageId: string, consumerId: string, now: string, leaseMs = 60_000): { state: 'CLAIMED'; claimToken: string; leaseUntil: string; attempts: number } {
    const id = z.uuid().parse(messageId); const consumer = ConsumerSchema.parse(consumerId);
    UtcTimestampSchema.parse(now); const lease = LeaseMsSchema.parse(leaseMs);
    const until = new Date(Date.parse(now) + lease).toISOString();
    const tx = this.db.transaction(() => {
      if (!this.db.prepare('SELECT 1 FROM wa_messages WHERE id=?').get(id)) throw new Error('Message state not found');
      const row = this.db.prepare(`SELECT state,claim_token,lease_until,attempt_count FROM wa_ai_consumer_message_state WHERE message_id=? AND consumer_id=?`).get(id, consumer) as { state: string; claim_token: string | null; lease_until: string | null; attempt_count: number } | undefined;
      if (row?.state === 'CLAIMED' && row.lease_until && row.lease_until > now) throw new Error('STATE_CONFLICT');
      if (row && !['UNREAD','FAILED','CLAIMED'].includes(row.state)) throw new Error('STATE_CONFLICT');
      const token = randomUUID();
      if (row) this.db.prepare(`UPDATE wa_ai_consumer_message_state SET state='CLAIMED',version=version+1,attempt_count=attempt_count+1,claim_token=?,lease_until=?,updated_at=?,last_error_code=NULL WHERE message_id=? AND consumer_id=?`).run(token, until, now, id, consumer);
      else this.db.prepare(`INSERT INTO wa_ai_consumer_message_state(message_id,consumer_id,state,attempt_count,claim_token,lease_until,updated_at) VALUES(?,?,'CLAIMED',1,?,?,?)`).run(id, consumer, token, until, now);
      this.audit(id, 'UNREAD', 'CLAIMED', consumer, now);
      return { state: 'CLAIMED' as const, claimToken: token, leaseUntil: until, attempts: (row?.attempt_count ?? 0) + 1 };
    });
    return tx.immediate();
  }

  acknowledgeForConsumer(messageId: string, consumerId: string, claimToken: string, now: string): { state: 'READ' } {
    const id = z.uuid().parse(messageId); const consumer = ConsumerSchema.parse(consumerId); const token = z.uuid().parse(claimToken); UtcTimestampSchema.parse(now);
    const tx = this.db.transaction(() => {
      const row = this.db.prepare(`SELECT state,claim_token,lease_until FROM wa_ai_consumer_message_state WHERE message_id=? AND consumer_id=?`).get(id, consumer) as { state: string; claim_token: string | null; lease_until: string | null } | undefined;
      if (!row || row.state !== 'CLAIMED' || row.claim_token !== token || !row.lease_until || row.lease_until <= now) throw new Error('ACK_FORBIDDEN');
      this.db.prepare(`UPDATE wa_ai_consumer_message_state SET state='READ',version=version+1,claim_token=NULL,lease_until=NULL,updated_at=? WHERE message_id=? AND consumer_id=?`).run(now, id, consumer);
      this.audit(id, 'CLAIMED', 'READ', consumer, now);
      return { state: 'READ' as const };
    });
    return tx.immediate();
  }

  failForConsumer(messageId: string, consumerId: string, claimToken: string, errorCode: string, now: string): void {
    const id = z.uuid().parse(messageId); const consumer = ConsumerSchema.parse(consumerId); const token = z.uuid().parse(claimToken); const code = z.string().regex(/^[A-Z0-9_]{1,64}$/).parse(errorCode); UtcTimestampSchema.parse(now);
    const tx = this.db.transaction(() => {
      const row = this.db.prepare(`SELECT state,claim_token FROM wa_ai_consumer_message_state WHERE message_id=? AND consumer_id=?`).get(id, consumer) as { state: string; claim_token: string | null } | undefined;
      if (!row || row.state !== 'CLAIMED' || row.claim_token !== token) throw new Error('ACK_FORBIDDEN');
      this.db.prepare(`UPDATE wa_ai_consumer_message_state SET state='FAILED',version=version+1,claim_token=NULL,lease_until=NULL,last_error_code=?,updated_at=? WHERE message_id=? AND consumer_id=?`).run(code, now, id, consumer);
      this.audit(id, 'CLAIMED', 'FAILED', consumer, now);
    });
    tx.immediate();
  }

  listRecoverable(consumerId: string, now: string, limit = 50): readonly { messageId: string; leaseExpired: boolean }[] {
    const consumer = ConsumerSchema.parse(consumerId); UtcTimestampSchema.parse(now); const bounded = z.number().int().min(1).max(100).parse(limit);
    return (this.db.prepare(`SELECT m.id AS messageId, (s.state='CLAIMED') AS leaseExpired FROM wa_messages m
      LEFT JOIN wa_ai_consumer_message_state s ON s.message_id=m.id AND s.consumer_id=?
      WHERE s.state IS NULL OR s.state='UNREAD' OR s.state='FAILED' OR (s.state='CLAIMED' AND s.lease_until<=?)
      ORDER BY m.observed_at,m.id LIMIT ?`).all(consumer, now, bounded) as { messageId: string; leaseExpired: number }[]).map((row) => ({ messageId: row.messageId, leaseExpired: row.leaseExpired === 1 }));
  }

}
