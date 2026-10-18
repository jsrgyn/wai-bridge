import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { ConversationIdentitySchema, type ConversationIdentity } from '@wai-bridge/shared';

export class ConversationIdentityRepository {
  constructor(private readonly db: Database.Database) {}

  resolve(
    input: ConversationIdentity,
    label: string | null,
    at: string,
  ): { conversationId: string; peerContactId: string | null } {
    const identity = ConversationIdentitySchema.parse(input);
    const key =
      identity.type === 'PHONE'
        ? identity.phone
        : identity.type === 'UI_CONTEXT'
          ? identity.conversationKey
          : identity.groupId;
    const phone =
      identity.type === 'PHONE'
        ? identity.phone
        : identity.type === 'UI_CONTEXT'
          ? (identity.phone ?? null)
          : null;
    const direct =
      identity.type === 'PHONE' ||
      (identity.type === 'UI_CONTEXT' && identity.conversationKind === 'INDIVIDUAL');
    const connector =
      identity.type === 'UI_CONTEXT' ? 'visible-ui-observation' : 'user-confirmed-ui';
    const scope = `local-account:${identity.accountId}`;
    const createPeer = () => {
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO wa_contacts(id,connector,account_scope,external_id,display_name,phone_number,identity_status,created_at,updated_at) VALUES(?,?,?,?,?,?,'PARTIAL',?,?)`,
        )
        .run(id, connector, scope, key, label, phone, at, at);
      return id;
    };
    const existing = this.db
      .prepare(
        `SELECT conversation_id AS conversationId, peer_contact_id AS peerContactId
      FROM wa_conversation_identities WHERE account_id=? AND reference_type=? AND reference_key=?`,
      )
      .get(identity.accountId, identity.type, key) as
      { conversationId: string; peerContactId: string | null } | undefined;
    if (existing) {
      const stored = this.db
        .prepare('SELECT kind FROM wa_conversations WHERE id=?')
        .get(existing.conversationId) as { kind: string };
      const incomingKind =
        identity.type === 'UI_CONTEXT'
          ? identity.conversationKind
          : identity.type === 'PHONE'
            ? 'INDIVIDUAL'
            : 'GROUP';
      if (
        stored.kind !== 'UNKNOWN' &&
        incomingKind !== 'UNKNOWN' &&
        stored.kind !== (incomingKind === 'INDIVIDUAL' ? 'DIRECT' : incomingKind)
      )
        throw new Error('CONVERSATION_KIND_CONFLICT');
      if (existing.peerContactId && phone) {
        const current = this.db
          .prepare('SELECT phone_number FROM wa_contacts WHERE id=?')
          .get(existing.peerContactId) as { phone_number: string | null };
        if (current.phone_number && current.phone_number !== phone)
          throw new Error('CONTACT_PHONE_CONFLICT');
      }
      if (!existing.peerContactId && direct) {
        existing.peerContactId = createPeer();
        this.db
          .prepare(
            'UPDATE wa_conversation_identities SET peer_contact_id=? WHERE conversation_id=?',
          )
          .run(existing.peerContactId, existing.conversationId);
      }
      if (identity.type === 'UI_CONTEXT' && identity.conversationKind !== 'UNKNOWN')
        this.db
          .prepare("UPDATE wa_conversations SET kind=? WHERE id=? AND kind='UNKNOWN'")
          .run(
            identity.conversationKind === 'INDIVIDUAL' ? 'DIRECT' : 'GROUP',
            existing.conversationId,
          );
      const title = label ?? (identity.type === 'GROUP_LOCAL' ? identity.groupLabel : null);
      this.db
        .prepare(
          `UPDATE wa_conversations SET title=COALESCE(?,title),updated_at=? WHERE id=? AND julianday(updated_at)<=julianday(?)`,
        )
        .run(title, at, existing.conversationId, at);
      if (existing.peerContactId)
        this.db
          .prepare(
            `UPDATE wa_contacts SET display_name=COALESCE(?,display_name),phone_number=COALESCE(?,phone_number),updated_at=? WHERE id=? AND julianday(updated_at)<=julianday(?)`,
          )
          .run(label, phone, at, existing.peerContactId, at);
      this.db
        .prepare(
          `UPDATE wa_conversation_identities SET confirmed_at=? WHERE conversation_id=? AND julianday(confirmed_at)<julianday(?)`,
        )
        .run(identity.confirmedAt, existing.conversationId, identity.confirmedAt);
      return existing;
    }
    const conversationId = randomUUID();
    const peerContactId = direct ? createPeer() : null;
    this.db
      .prepare(
        `INSERT INTO wa_conversations(id,connector,account_scope,external_id,kind,title,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`,
      )
      .run(
        conversationId,
        connector,
        scope,
        `${identity.type}:${key}`,
        identity.type === 'PHONE'
          ? 'DIRECT'
          : identity.type === 'UI_CONTEXT'
            ? identity.conversationKind === 'INDIVIDUAL'
              ? 'DIRECT'
              : identity.conversationKind
            : 'GROUP',
        label ?? (identity.type === 'GROUP_LOCAL' ? identity.groupLabel : null),
        at,
        at,
      );
    this.db
      .prepare(
        `INSERT INTO wa_conversation_identities(conversation_id,account_id,reference_type,reference_key,peer_contact_id,source,confirmed_at)
      VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        conversationId,
        identity.accountId,
        identity.type,
        key,
        peerContactId,
        identity.source,
        identity.confirmedAt,
      );
    this.db
      .prepare(
        `INSERT INTO wa_audit_log(id,actor_type,actor_id,action,resource_type,resource_id,at,outcome,correlation_id,metadata_json)
      VALUES(?,?,'local-api-principal',?,'conversation',?,?,'SUCCESS',?,?)`,
      )
      .run(
        randomUUID(),
        identity.type === 'UI_CONTEXT' ? 'SYSTEM' : 'USER',
        identity.type === 'UI_CONTEXT'
          ? 'conversation.reference-observed'
          : 'conversation.reference-confirmed',
        conversationId,
        at,
        identity.contextId,
        JSON.stringify({
          source: identity.source,
          accountId: identity.accountId,
          referenceType: identity.type,
          confirmedAt: identity.confirmedAt,
        }),
      );
    return { conversationId, peerContactId };
  }
}
