import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { CommandInsertSchema, type CommandInsert } from '../schemas.js';
export class CommandRepository {
  constructor(private readonly db: Database.Database) {}
  create(input: CommandInsert): { readonly inserted: boolean; readonly id: string } {
    const value = CommandInsertSchema.parse(input);
    const payload = JSON.stringify(value.payload);
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ kind: value.kind, payload }))
      .digest('hex');
    if (requestHash !== value.requestHash)
      throw new Error('requestHash does not match command content');
    const transaction = this.db.transaction(() => {
      const result = this.db
        .prepare(
          'INSERT OR IGNORE INTO wa_outbox(id,kind,idempotency_scope,idempotency_key,request_hash,status,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
        )
        .run(
          value.id,
          value.kind,
          value.idempotencyScope,
          value.idempotencyKey,
          value.requestHash,
          value.status,
          payload,
          value.createdAt,
          value.createdAt,
        );
      if (result.changes === 0) {
        const existing = this.db
          .prepare(
            'SELECT id,request_hash FROM wa_outbox WHERE idempotency_scope=? AND idempotency_key=?',
          )
          .get(value.idempotencyScope, value.idempotencyKey) as
          { id: string; request_hash: string } | undefined;
        if (!existing || existing.request_hash !== value.requestHash)
          throw new Error('IDEMPOTENCY_CONFLICT');
        return { inserted: false, id: existing.id };
      }
      this.db
        .prepare(
          'INSERT INTO wa_outbox_history(id,command_id,from_status,to_status,actor,at,correlation_id) VALUES(?,?,NULL,?,?,?,?)',
        )
        .run(`${value.id}:created`, value.id, value.status, 'system', value.createdAt, value.id);
      return { inserted: true, id: value.id };
    });
    return transaction.immediate();
  }
  transition(input: {
    commandId: string;
    toStatus: string;
    actor: string;
    at: string;
    correlationId: string;
    reasonCode?: string;
  }): void {
    const tx = this.db.transaction(() => {
      const current = this.db
        .prepare('SELECT status FROM wa_outbox WHERE id=?')
        .get(input.commandId) as { status: string } | undefined;
      if (!current) throw new Error('Command not found');
      if (current.status === input.toStatus) return;
      this.db
        .prepare('UPDATE wa_outbox SET status=?,updated_at=? WHERE id=?')
        .run(input.toStatus, input.at, input.commandId);
      this.db
        .prepare(
          'INSERT INTO wa_outbox_history(id,command_id,from_status,to_status,actor,at,reason_code,correlation_id) VALUES(?,?,?,?,?,?,?,?)',
        )
        .run(
          randomUUID(),
          input.commandId,
          current.status,
          input.toStatus,
          input.actor,
          input.at,
          input.reasonCode ?? null,
          input.correlationId,
        );
      this.db
        .prepare(
          'INSERT INTO wa_audit_log(id,actor_type,actor_id,action,resource_type,resource_id,at,outcome,correlation_id,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          randomUUID(),
          'system',
          input.actor,
          'outbox.status.changed',
          'outbox',
          input.commandId,
          input.at,
          'success',
          input.correlationId,
          JSON.stringify({
            from: current.status,
            to: input.toStatus,
            reasonCode: input.reasonCode ?? null,
          }),
        );
    });
    tx.immediate();
  }
  get(id: string): unknown {
    return this.db.prepare('SELECT * FROM wa_outbox WHERE id=?').get(id);
  }
  list(limit: number, afterId?: string): readonly unknown[] {
    return this.db
      .prepare(
        'SELECT id,kind,idempotency_scope AS idempotencyScope,idempotency_key AS idempotencyKey,status,created_at AS createdAt,updated_at AS updatedAt,result_ref AS resultRef FROM wa_outbox WHERE (? IS NULL OR id>?) ORDER BY id LIMIT ?',
      )
      .all(afterId ?? null, afterId ?? null, limit);
  }
  history(id: string): readonly unknown[] {
    return this.db
      .prepare(
        'SELECT from_status AS fromStatus,to_status AS toStatus,actor,at,reason_code AS reasonCode,correlation_id AS correlationId FROM wa_outbox_history WHERE command_id=? ORDER BY at,id',
      )
      .all(id);
  }
}
