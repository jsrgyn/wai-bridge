import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  EventEnvelopeSchema,
  EventInputSchema,
  type EventEnvelope,
  type EventInput,
} from './contracts.js';

export class EventRepository {
  constructor(private readonly db: Database.Database) {}

  append(eventInput: EventInput): { event: EventEnvelope; duplicate: boolean } {
    const input = EventInputSchema.parse(eventInput);
    const payloadJson = JSON.stringify(input.payload);
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          type: input.type,
          aggregateType: input.aggregateType,
          aggregateId: input.aggregateId,
          payloadVersion: input.payloadVersion,
          payloadJson,
        }),
      )
      .digest('hex');
    const tx = this.db.transaction(() => {
      const existing = this.db
        .prepare(
          'SELECT id,event_type,aggregate_type,aggregate_id,sequence,occurred_at,payload_version,payload_json,idempotency_scope,idempotency_key FROM wa_events WHERE id=? OR (idempotency_scope=? AND idempotency_key=?) LIMIT 1',
        )
        .get(input.id, input.idempotencyScope ?? null, input.idempotencyKey ?? null) as
        EventRow | undefined;
      if (existing) {
        const existingHash = createHash('sha256')
          .update(
            JSON.stringify({
              type: existing.event_type,
              aggregateType: existing.aggregate_type,
              aggregateId: existing.aggregate_id,
              payloadVersion: existing.payload_version,
              payloadJson: existing.payload_json,
            }),
          )
          .digest('hex');
        if (existingHash !== requestHash) throw new Error('IDEMPOTENCY_CONFLICT');
        return { event: rowToEvent(existing), duplicate: true };
      }
      const nextSequence = (
        this.db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM wa_events').get() as {
          sequence: number;
        }
      ).sequence;
      const event = EventEnvelopeSchema.parse({ ...input, sequence: nextSequence });
      this.db
        .prepare(
          'INSERT INTO wa_events(id,event_type,aggregate_type,aggregate_id,sequence,occurred_at,payload_version,payload_json,idempotency_scope,idempotency_key) VALUES(?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          event.id,
          event.type,
          event.aggregateType,
          event.aggregateId,
          event.sequence,
          event.occurredAt,
          event.payloadVersion,
          payloadJson,
          event.idempotencyScope ?? null,
          event.idempotencyKey ?? null,
        );
      this.db
        .prepare(
          "INSERT INTO wa_event_delivery(id,event_id,consumer_id,attempt,status,cursor,next_attempt_at,max_attempts) VALUES(?,?,?,0,'PENDING',?,?,?)",
        )
        .run(
          randomUUID(),
          event.id,
          'websocket:broadcast',
          String(event.sequence),
          event.occurredAt,
          8,
        );
      return { event, duplicate: false };
    });
    return tx.immediate();
  }

  getPendingCount(): number {
    return (
      this.db
        .prepare(
          "SELECT count(*) AS count FROM wa_event_delivery WHERE status='PENDING' OR (status='FAILED' AND dead_lettered_at IS NULL)",
        )
        .get() as { count: number }
    ).count;
  }
  getEvent(id: string): EventEnvelope | undefined {
    const row = this.db.prepare('SELECT * FROM wa_events WHERE id=?').get(id) as
      EventRow | undefined;
    return row ? rowToEvent(row) : undefined;
  }
  listPending(afterSequence = 0, limit = 100): readonly EventEnvelope[] {
    const rows = this.db
      .prepare(
        "SELECT e.* FROM wa_events e JOIN wa_event_delivery d ON d.event_id=e.id WHERE d.status='PENDING' AND CAST(d.cursor AS INTEGER)>? ORDER BY e.sequence LIMIT ?",
      )
      .all(afterSequence, Math.min(500, Math.max(1, limit))) as EventRow[];
    return rows.map(rowToEvent);
  }
  listEvents(afterSequence = 0, limit = 100): readonly EventEnvelope[] {
    const rows = this.db
      .prepare('SELECT * FROM wa_events WHERE sequence>? ORDER BY sequence ASC LIMIT ?')
      .all(afterSequence, Math.min(500, Math.max(1, limit))) as EventRow[];
    return rows.map(rowToEvent);
  }
}
interface EventRow {
  id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  sequence: number;
  occurred_at: string;
  payload_version: number;
  payload_json: string;
  idempotency_scope: string | null;
  idempotency_key: string | null;
}
function rowToEvent(row: EventRow): EventEnvelope {
  return EventEnvelopeSchema.parse({
    id: row.id,
    type: row.event_type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    sequence: row.sequence,
    occurredAt: row.occurred_at,
    payloadVersion: row.payload_version,
    payload: JSON.parse(row.payload_json),
    ...(row.idempotency_scope ? { idempotencyScope: row.idempotency_scope } : {}),
    ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
  });
}
