import type Database from 'better-sqlite3';
import { CaptureObservationSchema, type CaptureObservation } from '@wai-bridge/shared';

export class CaptureObservationRepository {
  constructor(private readonly db: Database.Database) {}

  record(
    extensionInstanceId: string,
    value: CaptureObservation,
    publish: (observation: CaptureObservation) => string,
  ): { eventId: string; duplicate: boolean } {
    const observation = CaptureObservationSchema.parse(value);
    const payload = JSON.stringify(observation);
    const tx = this.db.transaction(() => {
      const existing = this.db.prepare('SELECT extension_instance_id AS extensionInstanceId, payload_json AS payloadJson, event_id AS eventId FROM wa_capture_observations WHERE id=?')
        .get(observation.observationId) as { extensionInstanceId: string; payloadJson: string; eventId: string | null } | undefined;
      if (existing) {
        if (existing.extensionInstanceId !== extensionInstanceId || existing.payloadJson !== payload || !existing.eventId) throw new Error('IDEMPOTENCY_CONFLICT');
        return { eventId: existing.eventId, duplicate: true };
      }
      this.db.prepare(`
        INSERT INTO wa_capture_observations(id,extension_instance_id,observation_type,capture_state,observed_at,payload_json)
        VALUES(?,?,?,?,?,?)
      `).run(observation.observationId, extensionInstanceId, observation.observationType, observation.captureState, observation.observedAt, payload);
      const eventId = publish(observation);
      this.db.prepare('UPDATE wa_capture_observations SET event_id=? WHERE id=?').run(eventId, observation.observationId);
      return { eventId, duplicate: false };
    });
    return tx.immediate();
  }

  get(id: string): CaptureObservation | undefined {
    const row = this.db.prepare('SELECT payload_json AS payloadJson FROM wa_capture_observations WHERE id=?')
      .get(id) as { payloadJson: string } | undefined;
    return row ? CaptureObservationSchema.parse(JSON.parse(row.payloadJson) as unknown) : undefined;
  }
}
