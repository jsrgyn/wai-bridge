import { randomUUID, createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  ReferenceCandidatePageSchema,
  MaintenanceStatusSchema,
  OperationSummarySchema,
  ContactEditFieldsSchema,
  ContactCreateSchema,
  ContactUpdateSchema,
  ContactCatalogSchema,
  ConversationPolicySchema,
  PolicyUpdateSchema,
  MaintenancePolicySchema,
  MaintenanceUpdateSchema,
  CandidateQuerySchema,
  CandidateDecisionSchema,
  ExtensionTelemetrySchema,
} from '@wai-bridge/shared';
import { z } from 'zod';
import { ConversationReviewRepository } from './conversation-review.js';
import { ContactDirectoryRepository } from './contact-directory.js';
export class OperationsRepository {
  constructor(private readonly db: Database.Database) {
    new ContactDirectoryRepository(db);
  }
  replay<T extends { id: string }>(
    key: string,
    payload: unknown,
    work: () => T,
    load: (id: string) => T,
  ): T {
    return this.db
      .transaction(() => {
        const digest = JSON.stringify(
          createHash('sha256')
            .update(key)
            .update('\0')
            .update(JSON.stringify(payload))
            .digest('hex'),
        );
        const prior = this.db
          .prepare(
            'SELECT payload_json,result_json FROM wa_management_replays WHERE idempotency_key=?',
          )
          .get(key) as { payload_json: string; result_json: string } | undefined;
        if (prior) {
          if (prior.payload_json !== digest) throw Error('IDEMPOTENCY_CONFLICT');
          const ref = JSON.parse(prior.result_json) as { resourceId: string };
          return load(ref.resourceId);
        }
        const result = work();
        const id = z.uuid().parse(result.id);
        this.db
          .prepare('INSERT INTO wa_management_replays VALUES(?,?,?)')
          .run(key, digest, JSON.stringify({ resourceId: id }));
        return result;
      })
      .immediate();
  }
  contact(id: string) {
    const row = this.db
      .prepare(
        `SELECT c.id,c.account_scope accountScope,c.created_at registeredAt,
 CASE WHEN p.contact_id IS NULL THEN c.display_name ELSE p.name END name,
 CASE WHEN p.contact_id IS NULL THEN c.nickname ELSE p.nickname END nickname,
 CASE WHEN p.contact_id IS NULL THEN c.full_name ELSE p.full_name END fullName,
 CASE WHEN p.contact_id IS NULL THEN c.phone_number ELSE p.phone END phone,
 COALESCE(p.relationships_json,'[]') relationshipsJson,COALESCE(p.version,0) version,
 CASE WHEN p.contact_id IS NOT NULL AND p.phone IS NOT NULL THEN 'USER_ASSERTED' WHEN c.phone_number IS NOT NULL AND p.contact_id IS NULL THEN 'OBSERVED' ELSE 'UNKNOWN' END phoneSource
 FROM wa_contacts c LEFT JOIN wa_contact_catalog p ON p.contact_id=c.id WHERE c.id=?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!row) throw Error('CONTACT_NOT_FOUND');
    const { relationshipsJson, ...rest } = row;
    return ContactCatalogSchema.parse({
      ...rest,
      relationships: JSON.parse(String(relationshipsJson)),
    });
  }
  create(raw: unknown) {
    const input = ContactCreateSchema.parse(raw);
    return this.replay(
      input.idempotencyKey,
      { operation: 'CREATE', input },
      () => {
        const id = randomUUID(),
          at = new Date().toISOString();
        this.db
          .prepare(
            "INSERT INTO wa_contacts(id,connector,account_scope,display_name,identity_status,created_at,updated_at) VALUES(?,'user-local-catalog',?,?,'UNKNOWN',?,?)",
          )
          .run(id, `local-account:${input.accountId}`, input.name, at, at);
        this.save(id, input, 1);
        this.audit('contact.created', id);
        return this.contact(id);
      },
      (id) => this.contact(id),
    );
  }
  update(id: string, raw: unknown) {
    const input = ContactUpdateSchema.parse(raw);
    return this.replay(
      input.idempotencyKey,
      { operation: 'UPDATE', id, input },
      () => {
        const current = this.contact(id);
        if (current.version !== input.expectedVersion) throw Error('CONTACT_VERSION_CONFLICT');
        this.save(
          id,
          ContactEditFieldsSchema.parse(
            Object.fromEntries(
              Object.entries({ ...current, ...input }).filter(
                ([k, v]) =>
                  ['name', 'nickname', 'fullName', 'phone', 'relationships'].includes(k) &&
                  v !== undefined,
              ),
            ),
          ),
          current.version + 1,
        );
        this.audit('contact.updated', id);
        return this.contact(id);
      },
      (id) => this.contact(id),
    );
  }
  private save(
    id: string,
    input: {
      name: string | null;
      nickname: string | null;
      fullName: string | null;
      phone: string | null;
      relationships: string[];
    },
    version: number,
  ) {
    this.db
      .prepare(
        `INSERT INTO wa_contact_catalog VALUES(?,?,?,?,?,?,?) ON CONFLICT(contact_id) DO UPDATE SET name=excluded.name,nickname=excluded.nickname,full_name=excluded.full_name,phone=excluded.phone,relationships_json=excluded.relationships_json,version=excluded.version`,
      )
      .run(
        id,
        input.name,
        input.nickname,
        input.fullName,
        input.phone,
        JSON.stringify(input.relationships),
        version,
      );
  }
  policy(id: string) {
    if (!this.db.prepare('SELECT 1 FROM wa_conversations WHERE id=?').get(id))
      throw Error('CONVERSATION_NOT_FOUND');
    const row = this.db
      .prepare(
        'SELECT favorite,priority,batch_mode batchMode FROM wa_conversation_policies WHERE conversation_id=?',
      )
      .get(id) as { favorite: number; priority: number; batchMode: string } | undefined;
    return ConversationPolicySchema.parse(row ? { ...row, favorite: Boolean(row.favorite) } : {});
  }
  setPolicy(id: string, raw: unknown) {
    const input = PolicyUpdateSchema.parse(raw);
    this.policy(id);
    this.db
      .transaction(() => {
        this.db
          .prepare(
            `INSERT INTO wa_conversation_policies VALUES(?,?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET favorite=excluded.favorite,priority=excluded.priority,batch_mode=excluded.batch_mode,updated_at=excluded.updated_at`,
          )
          .run(
            id,
            Number(input.favorite),
            input.priority,
            input.batchMode,
            new Date().toISOString(),
          );
        this.audit('conversation.policy-updated', id);
      })
      .immediate();
    return this.policy(id);
  }
  candidates(raw: unknown) {
    const input = CandidateQuerySchema.parse(raw);
    const rows = this.db
      .prepare(
        `SELECT a.id leftId,b.id rightId,a.title leftTitle,b.title rightTitle,CASE WHEN pa.phone_number IS NOT NULL AND pa.phone_number=pb.phone_number THEN 'PHONE_MATCH' ELSE 'NAME_MATCH' END reason
 FROM wa_conversations a JOIN wa_conversation_identities ia ON ia.conversation_id=a.id
 JOIN wa_conversation_identities ib ON ib.account_id=ia.account_id AND ib.conversation_id>a.id
 JOIN wa_conversations b ON b.id=ib.conversation_id
 LEFT JOIN wa_contacts pa ON pa.id=ia.peer_contact_id LEFT JOIN wa_contacts pb ON pb.id=ib.peer_contact_id
 WHERE (? IS NULL OR ia.account_id=?) AND (a.kind=b.kind OR a.kind='UNKNOWN' OR b.kind='UNKNOWN')
 AND (pa.phone_number IS NULL OR pb.phone_number IS NULL OR pa.phone_number=pb.phone_number)
 AND ((pa.phone_number IS NOT NULL AND pa.phone_number=pb.phone_number) OR (length(trim(COALESCE(a.title,'')))>0 AND wai_contact_fold(a.title)=wai_contact_fold(b.title)))
 AND NOT EXISTS(SELECT 1 FROM wa_reference_decisions d WHERE d.left_id=a.id AND d.right_id=b.id)
 AND NOT EXISTS(SELECT 1 FROM wa_conversation_review_links l WHERE l.conversation_id=a.id AND l.related_conversation_id=b.id)
 AND (? IS NULL OR a.id||':'||b.id>?) ORDER BY a.id,b.id LIMIT ?`,
      )
      .all(
        input.accountId ?? null,
        input.accountId ?? null,
        input.cursor ?? null,
        input.cursor ?? null,
        input.limit + 1,
      ) as Array<{ leftId: string; rightId: string }>;
    const items = rows.slice(0, input.limit);
    return ReferenceCandidatePageSchema.parse({
      items,
      nextCursor:
        rows.length > input.limit ? `${items.at(-1)!.leftId}:${items.at(-1)!.rightId}` : null,
      historiesMerged: false,
    });
  }
  decide(raw: unknown) {
    const input = CandidateDecisionSchema.parse(raw);
    if (input.leftId === input.rightId) throw Error('REVIEW_IDENTITY_CONFLICT');
    return this.db
      .transaction(() => {
        const reviews = new ConversationReviewRepository(this.db);
        reviews.reference(input.leftId);
        reviews.reference(input.rightId);
        if (input.decision === 'LINK')
          reviews.link(input.leftId, {
            relatedConversationId: input.rightId,
            explicitConfirmation: true,
          });
        const [a, b] = [input.leftId, input.rightId].sort();
        this.db
          .prepare(
            'INSERT INTO wa_reference_decisions VALUES(?,?,?,?) ON CONFLICT(left_id,right_id) DO UPDATE SET decision=excluded.decision,at=excluded.at',
          )
          .run(a, b, input.decision, new Date().toISOString());
        this.audit('conversation.reference-reviewed', input.leftId);
        return { ...input, historiesMerged: false };
      })
      .immediate();
  }
  maintenance() {
    const row = this.db
      .prepare('SELECT payload_json FROM wa_maintenance_settings WHERE id=1')
      .get() as { payload_json: string } | undefined;
    return MaintenanceStatusSchema.parse({
      policy: MaintenancePolicySchema.parse(row ? JSON.parse(row.payload_json) : {}),
      runs: this.db
        .prepare(
          'SELECT id,file_name fileName,status,created_at createdAt,completed_at completedAt,size_bytes sizeBytes,code FROM wa_backup_runs ORDER BY created_at DESC LIMIT 20',
        )
        .all(),
    });
  }
  setMaintenance(raw: unknown) {
    const input = MaintenanceUpdateSchema.parse(raw);
    const policy = MaintenancePolicySchema.parse(
      Object.fromEntries(
        Object.entries(input).filter(
          ([key]) => key !== 'explicitConfirmation' && key !== 'authorizeDeletion',
        ),
      ),
    );
    this.db
      .transaction(() => {
        this.db
          .prepare(
            'INSERT INTO wa_maintenance_settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json',
          )
          .run(JSON.stringify(policy));
        this.audit('maintenance.policy-updated', 'local');
      })
      .immediate();
    return this.maintenance();
  }
  telemetry(id: string, raw: unknown) {
    const input = ExtensionTelemetrySchema.parse(raw);
    this.db
      .prepare(
        'INSERT INTO wa_extension_telemetry VALUES(?,?,?) ON CONFLICT(extension_instance_id) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at',
      )
      .run(id, JSON.stringify(input), new Date().toISOString());
    return { accepted: true };
  }
  summary() {
    const count = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return OperationSummarySchema.parse({
      coverageComplete: false,
      counts: {
        unprojectedCaptures: count(
          'SELECT COUNT(*) n FROM wa_capture_observations o WHERE NOT EXISTS(SELECT 1 FROM wa_capture_normalizations n WHERE n.observation_id=o.id)',
        ),
        failedCaptures: count(
          "SELECT COUNT(*) n FROM wa_capture_observations WHERE capture_state='FAILED'",
        ),
        contacts: count('SELECT COUNT(*) n FROM wa_contacts'),
        pending: count(
          'SELECT COUNT(*) n FROM wa_conversation_reviews WHERE revision>acknowledged_revision',
        ),
        failedBatches: count(
          "SELECT COUNT(*) n FROM wa_dialogue_sync_batches WHERE status='COMPLETED_WITH_ERRORS'",
        ),
      },
      batches: this.db
        .prepare(
          'SELECT id,status,reason,created_at createdAt FROM wa_dialogue_sync_batches ORDER BY created_at DESC LIMIT 20',
        )
        .all(),
      lastSync: this.db.prepare('SELECT MAX(last_sync_at) at FROM wa_conversation_reviews').get(),
      telemetry: (
        this.db
          .prepare(
            'SELECT extension_instance_id id,payload_json,updated_at updatedAt FROM wa_extension_telemetry ORDER BY updated_at DESC LIMIT 10',
          )
          .all() as Array<{ id: string; payload_json: string; updatedAt: string }>
      ).map(({ payload_json, ...row }) => ({
        ...row,
        ...JSON.parse(payload_json),
        stale: Date.now() - Date.parse(row.updatedAt) > 60000,
      })),
      maintenance: this.maintenance(),
    });
  }
  private audit(action: string, id: string) {
    this.db
      .prepare(
        "INSERT INTO wa_audit_log(id,actor_type,actor_id,action,resource_type,resource_id,at,outcome,correlation_id,metadata_json) VALUES(?,'USER','local-api-principal',?,'management',?,?,'SUCCESS',?,'{}')",
      )
      .run(randomUUID(), action, id, new Date().toISOString(), randomUUID());
  }
}
