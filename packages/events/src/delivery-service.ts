import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
export interface LeasedDelivery {
  readonly id: string;
  readonly eventId: string;
  readonly attempt: number;
  readonly leaseOwner: string;
  readonly leaseUntil: string;
}
export class EventDeliveryService {
  constructor(private readonly db: Database.Database) {}
  claim(workerId: string, now: string, leaseMs: number): LeasedDelivery | undefined {
    const leaseUntil = new Date(Date.parse(now) + leaseMs).toISOString();
    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare(
          "SELECT id,event_id,attempt,max_attempts FROM wa_event_delivery WHERE status='PENDING' AND attempt<max_attempts AND next_attempt_at<=? AND (lease_until IS NULL OR lease_until<=?) AND dead_lettered_at IS NULL ORDER BY next_attempt_at,id LIMIT 1",
        )
        .get(now, now) as
        { id: string; event_id: string; attempt: number; max_attempts: number } | undefined;
      if (!row) return undefined;
      const attempt = row.attempt + 1;
      const updated = this.db
        .prepare(
          "UPDATE wa_event_delivery SET attempt=?,lease_owner=?,lease_until=? WHERE id=? AND status='PENDING' AND (lease_until IS NULL OR lease_until<=?)",
        )
        .run(attempt, workerId, leaseUntil, row.id, now);
      if (updated.changes !== 1) return undefined;
      this.db
        .prepare(
          "INSERT INTO wa_event_delivery_attempt(id,delivery_id,attempt,worker_id,started_at,outcome) VALUES(?,?,?,?,?,'RUNNING')",
        )
        .run(randomUUID(), row.id, attempt, workerId, now);
      return { id: row.id, eventId: row.event_id, attempt, leaseOwner: workerId, leaseUntil };
    });
    return tx.immediate();
  }
  delivered(delivery: LeasedDelivery, now: string): void {
    const tx = this.db.transaction(() => {
      const attempt = this.db
        .prepare(
          "UPDATE wa_event_delivery_attempt SET finished_at=?,outcome='DELIVERED' WHERE delivery_id=? AND attempt=? AND worker_id=? AND outcome='RUNNING'",
        )
        .run(now, delivery.id, delivery.attempt, delivery.leaseOwner);
      if (attempt.changes !== 1)
        throw new Error('Delivery attempt is no longer owned by this worker');
      const result = this.db
        .prepare(
          "UPDATE wa_event_delivery SET status='DELIVERED',delivered_at=?,lease_owner=NULL,lease_until=NULL,last_error_code=NULL WHERE id=? AND lease_owner=? AND attempt=?",
        )
        .run(now, delivery.id, delivery.leaseOwner, delivery.attempt);
      if (result.changes !== 1) throw new Error('Delivery lease was lost');
    });
    tx.immediate();
  }
  retry(
    delivery: LeasedDelivery,
    now: string,
    errorCode: string,
    nextAttemptAt: string,
    permanent = false,
  ): { deadLettered: boolean } {
    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare(
          'SELECT max_attempts FROM wa_event_delivery WHERE id=? AND lease_owner=? AND attempt=?',
        )
        .get(delivery.id, delivery.leaseOwner, delivery.attempt) as
        { max_attempts: number } | undefined;
      if (!row) throw new Error('Delivery lease was lost');
      const deadLettered = permanent || delivery.attempt >= row.max_attempts;
      this.db
        .prepare(
          "UPDATE wa_event_delivery_attempt SET finished_at=?,outcome=?,error_code=? WHERE delivery_id=? AND attempt=? AND worker_id=? AND outcome='RUNNING'",
        )
        .run(
          now,
          deadLettered ? 'DEAD_LETTER' : 'RETRY',
          errorCode,
          delivery.id,
          delivery.attempt,
          delivery.leaseOwner,
        );
      this.db
        .prepare(
          'UPDATE wa_event_delivery SET status=?,next_attempt_at=?,last_error_code=?,lease_owner=NULL,lease_until=NULL,dead_lettered_at=? WHERE id=?',
        )
        .run(
          deadLettered ? 'FAILED' : 'PENDING',
          nextAttemptAt,
          errorCode,
          deadLettered ? now : null,
          delivery.id,
        );
      return { deadLettered };
    });
    return tx.immediate();
  }
  recoverExpired(now: string): number {
    const tx = this.db.transaction(() => {
      const expired = this.db
        .prepare(
          "SELECT id,attempt,max_attempts FROM wa_event_delivery WHERE status='PENDING' AND lease_until IS NOT NULL AND lease_until<=?",
        )
        .all(now) as { id: string; attempt: number; max_attempts: number }[];
      for (const row of expired) {
        const deadLettered = row.attempt >= row.max_attempts;
        this.db
          .prepare(
            "UPDATE wa_event_delivery_attempt SET finished_at=?,outcome=?,error_code='WORKER_LEASE_EXPIRED' WHERE delivery_id=? AND outcome='RUNNING'",
          )
          .run(now, deadLettered ? 'DEAD_LETTER' : 'RETRY', row.id);
        this.db
          .prepare(
            "UPDATE wa_event_delivery SET status=?,lease_owner=NULL,lease_until=NULL,last_error_code='WORKER_LEASE_EXPIRED',next_attempt_at=?,dead_lettered_at=? WHERE id=?",
          )
          .run(deadLettered ? 'FAILED' : 'PENDING', now, deadLettered ? now : null, row.id);
      }
      return expired.length;
    });
    return tx.immediate();
  }
  getDeadLetters(): readonly unknown[] {
    return this.db
      .prepare(
        'SELECT d.*,e.event_type,e.payload_json FROM wa_event_delivery d JOIN wa_events e ON e.id=d.event_id WHERE d.dead_lettered_at IS NOT NULL ORDER BY d.dead_lettered_at',
      )
      .all();
  }
}
