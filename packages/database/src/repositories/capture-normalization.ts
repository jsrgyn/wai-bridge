import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { CaptureObservationSchema, type CaptureObservation } from '@wai-bridge/shared';
import { MessageRepository } from './messages.js';
import { ConversationIdentityRepository } from './conversation-identities.js';

export interface CaptureNormalization {
  conversationId: string;
  senderContactId: string | null;
  messageId: string | null;
  status: 'MESSAGE_CREATED' | 'CONVERSATION_ONLY' | 'DIRECTION_UNKNOWN';
}

export class CaptureNormalizationRepository {
  constructor(private readonly db: Database.Database) {}

  normalize(
    extensionInstanceId: string,
    input: CaptureObservation,
  ): CaptureNormalization & { created: boolean } {
    z.uuid().parse(extensionInstanceId);
    const observation = CaptureObservationSchema.parse(input);
    const tx = this.db.transaction(() => {
      // Require the exact staging payload. A reference alone never authorizes projection.
      const staged = this.db
        .prepare(
          'SELECT extension_instance_id, payload_json FROM wa_capture_observations WHERE id=?',
        )
        .get(observation.observationId) as
        { extension_instance_id: string; payload_json: string } | undefined;
      if (
        !staged ||
        staged.extension_instance_id !== extensionInstanceId ||
        staged.payload_json !== JSON.stringify(observation)
      ) {
        throw new Error('IDEMPOTENCY_CONFLICT');
      }
      const existing = this.db
        .prepare(
          `SELECT conversation_id AS conversationId, sender_contact_id AS senderContactId,
        message_id AS messageId, status FROM wa_capture_normalizations WHERE observation_id=?`,
        )
        .get(observation.observationId) as CaptureNormalization | undefined;
      if (existing) return { ...existing, created: false };

      const bound = observation.identity ? new ConversationIdentityRepository(this.db).resolve(observation.identity, observation.conversation.label, observation.observedAt) : undefined;
      const conversationId = bound?.conversationId ?? randomUUID();
      const scope = `extension-instance:${extensionInstanceId}`;
      const at = observation.observedAt;
      const kind =
        observation.conversation.kind === 'INDIVIDUAL' ? 'DIRECT' : observation.conversation.kind;
      if (!bound) this.db
        .prepare(
          `INSERT INTO wa_conversations(id,connector,account_scope,kind,title,created_at,updated_at)
        VALUES(?,'visible-ui-observation',?,?,?,?,?)`,
        )
        .run(conversationId, scope, kind, observation.conversation.label, at, at);

      let senderContactId: string | null = null;
      let messageId: string | null = null;
      let status: CaptureNormalization['status'] = 'CONVERSATION_ONLY';
      if (observation.observationType === 'MESSAGE' && observation.direction === 'UNKNOWN')
        status = 'DIRECTION_UNKNOWN';
      if (observation.observationType === 'MESSAGE' && observation.direction !== 'UNKNOWN') {
        if (observation.direction === 'INBOUND' && bound?.peerContactId) senderContactId = bound.peerContactId;
        else if (observation.direction === 'INBOUND' && observation.senderLabel) {
          senderContactId = randomUUID();
          this.db
            .prepare(
              `INSERT INTO wa_contacts(id,connector,account_scope,display_name,identity_status,created_at,updated_at)
            VALUES(?,'visible-ui-observation',?,?,'UNKNOWN',?,?)`,
            )
            .run(senderContactId, scope, observation.senderLabel, at, at);
        }
        messageId = randomUUID();
        new MessageRepository(this.db).insert({
          id: messageId,
          conversationId,
          senderContactId,
          direction: observation.direction,
          captureStatus: observation.captureState,
          content: observation.contentAvailability === 'AVAILABLE' ? observation.content : null,
          contentAvailability: observation.contentAvailability,
          observedAt: at,
          capturedAt: observation.captureState === 'CAPTURED' ? at : null,
          sequence: (this.db.prepare('SELECT COALESCE(MAX(sequence),0)+1 next FROM wa_messages WHERE conversation_id=?').get(conversationId) as {next:number}).next,
          idempotencyScope: scope,
          idempotencyKey: observation.observationId,
        });
        status = 'MESSAGE_CREATED';
        for (const hint of new Set(observation.media)) {
          this.db
            .prepare(
              `INSERT INTO wa_media(id,message_id,media_type,availability,processing_status,created_at)
            VALUES(?,?,?,'UNAVAILABLE','DETECTED',?)`,
            )
            .run(randomUUID(), messageId, hint === 'UNKNOWN' ? 'OTHER' : hint, at);
        }
      }
      this.db
        .prepare(
          `INSERT INTO wa_capture_normalizations(observation_id,conversation_id,sender_contact_id,message_id,status)
        VALUES(?,?,?,?,?)`,
        )
        .run(observation.observationId, conversationId, senderContactId, messageId, status);
      return { conversationId, senderContactId, messageId, status, created: true };
    });
    return tx.immediate();
  }
}
