import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { CaptureObservationSchema, type CaptureObservation } from '@wai-bridge/shared';
import { ConversationReviewRepository } from './conversation-review.js';
import { MessageRepository } from './messages.js';
import { ConversationIdentityRepository } from './conversation-identities.js';

export interface CaptureNormalization {
  conversationId: string;
  senderContactId: string | null;
  messageId: string | null;
  status: 'MESSAGE_CREATED' | 'MESSAGE_UPDATED' | 'CONVERSATION_ONLY' | 'DIRECTION_UNKNOWN';
}

export class CaptureNormalizationRepository {
  constructor(private readonly db: Database.Database) {}

  normalize(
    extensionInstanceId: string,
    input: CaptureObservation,
    trackReview = true,
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

      const ref = observation.messageRef;
      const previousRef = ref
        ? (this.db
            .prepare(
              'SELECT * FROM wa_capture_message_refs WHERE extension_instance_id=? AND reference_key=?',
            )
            .get(extensionInstanceId, ref.key) as
            | {
                conversation_id: string;
                message_id: string | null;
                latest_revision: number;
                latest_observation_id: string;
                first_observed_at: string;
              }
            | undefined)
        : undefined;
      if (previousRef && previousRef.first_observed_at !== ref!.firstObservedAt)
        throw new Error('CAPTURE_REVISION_CONFLICT');
      const bound = observation.identity
        ? new ConversationIdentityRepository(this.db).resolve(
            observation.identity,
            observation.conversation.label,
            observation.observedAt,
          )
        : undefined;
      const conversationId = bound?.conversationId ?? previousRef?.conversation_id ?? randomUUID();
      if (previousRef && previousRef.conversation_id !== conversationId)
        throw new Error('CAPTURE_REVISION_CONFLICT');
      const scope = `extension-instance:${extensionInstanceId}`;
      const at = observation.observedAt;
      const kind =
        observation.conversation.kind === 'INDIVIDUAL' ? 'DIRECT' : observation.conversation.kind;
      if (!bound && !previousRef)
        this.db
          .prepare(
            `INSERT INTO wa_conversations(id,connector,account_scope,kind,title,created_at,updated_at)
        VALUES(?,'visible-ui-observation',?,?,?,?,?)`,
          )
          .run(conversationId, scope, kind, observation.conversation.label, at, at);

      if (previousRef && ref!.revision <= previousRef.latest_revision) {
        if (
          ref!.revision === previousRef.latest_revision &&
          previousRef.latest_observation_id !== observation.observationId
        )
          throw new Error('CAPTURE_REVISION_CONFLICT');
        this.db
          .prepare(
            "INSERT INTO wa_capture_normalizations(observation_id,conversation_id,status) VALUES(?,?,'CONVERSATION_ONLY')",
          )
          .run(observation.observationId, conversationId);
        return {
          conversationId,
          senderContactId: null,
          messageId: null,
          status: 'CONVERSATION_ONLY' as const,
          created: true,
        };
      }
      let senderContactId: string | null = null;
      let messageId: string | null = null;
      let status: CaptureNormalization['status'] = 'CONVERSATION_ONLY';
      if (observation.observationType === 'MESSAGE' && observation.direction === 'UNKNOWN')
        status = 'DIRECTION_UNKNOWN';
      if (observation.observationType === 'MESSAGE' && observation.direction !== 'UNKNOWN') {
        if (observation.direction === 'INBOUND' && bound?.peerContactId)
          senderContactId = bound.peerContactId;
        else if (
          observation.direction === 'INBOUND' &&
          observation.senderLabel &&
          !previousRef?.message_id
        ) {
          senderContactId = randomUUID();
          this.db
            .prepare(
              `INSERT INTO wa_contacts(id,connector,account_scope,display_name,identity_status,created_at,updated_at)
            VALUES(?,'visible-ui-observation',?,?,'UNKNOWN',?,?)`,
            )
            .run(senderContactId, scope, observation.senderLabel, at, at);
        }
        if (previousRef?.message_id) {
          const current = this.db
            .prepare('SELECT direction,sender_contact_id FROM wa_messages WHERE id=?')
            .get(previousRef.message_id) as { direction: string; sender_contact_id: string | null };
          if (current.direction !== observation.direction)
            throw new Error('CAPTURE_DIRECTION_CONFLICT');
          messageId = previousRef.message_id;
          senderContactId = senderContactId ?? current.sender_contact_id;
          this.db
            .prepare(
              'UPDATE wa_messages SET content=?,content_availability=?,capture_status=?,captured_at=?,sender_contact_id=? WHERE id=?',
            )
            .run(
              observation.contentAvailability === 'AVAILABLE' ? observation.content : null,
              observation.contentAvailability,
              observation.captureState,
              observation.captureState === 'CAPTURED' ? at : null,
              senderContactId,
              messageId,
            );
          status = 'MESSAGE_UPDATED';
        } else {
          messageId = randomUUID();
          new MessageRepository(this.db).insert({
            id: messageId,
            conversationId,
            senderContactId,
            direction: observation.direction,
            captureStatus: observation.captureState,
            content: observation.contentAvailability === 'AVAILABLE' ? observation.content : null,
            contentAvailability: observation.contentAvailability,
            observedAt: ref?.firstObservedAt ?? at,
            capturedAt: observation.captureState === 'CAPTURED' ? at : null,
            sequence: (
              this.db
                .prepare(
                  'SELECT COALESCE(MAX(sequence),0)+1 next FROM wa_messages WHERE conversation_id=?',
                )
                .get(conversationId) as { next: number }
            ).next,
            idempotencyScope: scope,
            idempotencyKey: observation.observationId,
          });
          status = 'MESSAGE_CREATED';
        }
        for (const hint of new Set(observation.media)) {
          this.db
            .prepare(
              `INSERT INTO wa_media(id,message_id,media_type,availability,processing_status,created_at)
            SELECT ?,?,?,'UNAVAILABLE','DETECTED',? WHERE NOT EXISTS (SELECT 1 FROM wa_media WHERE message_id=? AND media_type=?)`,
            )
            .run(
              randomUUID(),
              messageId,
              hint === 'UNKNOWN' ? 'OTHER' : hint,
              at,
              messageId,
              hint === 'UNKNOWN' ? 'OTHER' : hint,
            );
        }
      }
      if (ref)
        this.db
          .prepare(
            `INSERT INTO wa_capture_message_refs(extension_instance_id,reference_key,conversation_id,message_id,latest_revision,latest_observation_id,first_observed_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(extension_instance_id,reference_key) DO UPDATE SET message_id=COALESCE(excluded.message_id,wa_capture_message_refs.message_id), latest_revision=excluded.latest_revision,latest_observation_id=excluded.latest_observation_id`,
          )
          .run(
            extensionInstanceId,
            ref.key,
            conversationId,
            messageId,
            ref.revision,
            observation.observationId,
            ref.firstObservedAt,
          );
      this.db
        .prepare(
          `INSERT INTO wa_capture_normalizations(observation_id,conversation_id,sender_contact_id,message_id,status)
        VALUES(?,?,?,?,?)`,
        )
        .run(observation.observationId, conversationId, senderContactId, messageId, status);
      if (trackReview && (observation.observationType === 'CONVERSATION_ACTIVITY' || status === 'MESSAGE_CREATED' || status === 'MESSAGE_UPDATED'))
        new ConversationReviewRepository(this.db).signal(conversationId, observation);
      return { conversationId, senderContactId, messageId, status, created: true };
    });
    return tx.immediate();
  }
}
