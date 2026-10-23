import { z } from 'zod';
import { SendTimingOverrideSchema } from './extension-send.js';
const text = z.string().trim().min(1).max(256);
export const ContactEditFieldsSchema = z
  .object({
    name: text.nullable(),
    nickname: text.nullable(),
    fullName: text.nullable(),
    phone: z
      .string()
      .regex(/^\+[1-9]\d{6,14}$/)
      .nullable(),
    relationships: text.array().max(20),
  })
  .strict();
export const ContactCreateSchema = ContactEditFieldsSchema.extend({
  accountId: z.uuid(),
  explicitConfirmation: z.literal(true),
  idempotencyKey: z.string().min(16).max(128),
}).strict();
export const ContactUpdateSchema = ContactEditFieldsSchema.partial()
  .extend({
    expectedVersion: z.number().int().nonnegative(),
    explicitConfirmation: z.literal(true),
    idempotencyKey: z.string().min(16).max(128),
  })
  .strict()
  .refine(
    (v) => ['name', 'nickname', 'fullName', 'phone', 'relationships'].some((k) => k in v),
    'No fields to update',
  );
export const ContactCatalogSchema = ContactEditFieldsSchema.extend({
  id: z.uuid(),
  accountScope: z.string(),
  version: z.number().int().nonnegative(),
  phoneSource: z.enum(['OBSERVED', 'USER_ASSERTED', 'UNKNOWN']),
  registeredAt: z.iso.datetime(),
}).strict();
export const CandidateQuerySchema = z
  .object({
    accountId: z.uuid().optional(),
    cursor: z
      .string()
      .regex(/^[0-9a-f-]{36}:[0-9a-f-]{36}$/)
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export const CandidateDecisionSchema = z
  .object({
    leftId: z.uuid(),
    rightId: z.uuid(),
    decision: z.enum(['LINK', 'DISMISS']),
    explicitConfirmation: z.literal(true),
  })
  .strict();
export const ConversationPolicySchema = z
  .object({
    favorite: z.boolean().default(false),
    priority: z.number().int().min(-100).max(100).default(0),
    batchMode: z.enum(['INCLUDE', 'EXCLUDE', 'INDIVIDUAL_ONLY']).default('INCLUDE'),
  })
  .strict();
export const PolicyUpdateSchema = ConversationPolicySchema.extend({
  explicitConfirmation: z.literal(true),
}).strict();
export const RetryBatchFailuresSchema = z
  .object({ explicitAuthorization: z.literal(true), idempotencyKey: z.string().min(16).max(128) })
  .strict();
export const MaintenancePolicySchema = z
  .object({
    backupEnabled: z.boolean().default(true),
    intervalHours: z.number().int().min(1).max(168).default(24),
    retentionDays: z.number().int().min(1).max(3650).default(30),
    maxBackupBytes: z.number().int().min(1048576).max(107374182400).default(536870912),
    minBackups: z.number().int().min(1).max(100).default(3),
    pruneBackups: z.boolean().default(false),
    logRetentionDays: z.number().int().min(1).max(3650).default(7),
    pruneLogs: z.boolean().default(false),
  })
  .strict();
export const MaintenanceUpdateSchema = MaintenancePolicySchema.extend({
  explicitConfirmation: z.literal(true),
  authorizeDeletion: z.boolean().default(false),
})
  .strict()
  .refine(
    (v) => (!v.pruneBackups && !v.pruneLogs) || v.authorizeDeletion,
    'Deletion requires specific authorization',
  );
export const QueueLimitsSchema = z
  .object({
    maxItems: z.number().int().min(100).max(10000).default(1000),
    maxBytes: z.number().int().min(65536).max(6291456).default(6291456),
  })
  .strict();
export const CaptureQueueDiagnosticsSchema = z
  .object({
    pending: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    quarantined: z.number().int().nonnegative(),
    overflowCount: z.number().int().nonnegative(),
    storageErrorCount: z.number().int().nonnegative(),
    retryCount: z.number().int().nonnegative(),
    lastAckAt: z.iso.datetime().nullable(),
    oldestAt: z.iso.datetime().nullable(),
    connected: z.boolean(),
    possibleGaps: z.boolean(),
    limits: QueueLimitsSchema,
    complete: z.literal(false),
  })
  .strict();
export const UiCompatibilitySchema = z
  .object({
    status: z.enum(['READY', 'PARTIAL', 'UNSUPPORTED', 'NO_CONVERSATION']),
    canCapture: z.boolean(),
    canSync: z.boolean(),
    canSend: z.boolean(),
    reasons: z.string().array().max(10),
    checkedAt: z.iso.datetime(),
  })
  .strict();
export const ExtensionTelemetrySchema = z
  .object({
    queue: CaptureQueueDiagnosticsSchema,
    compatibility: UiCompatibilitySchema.optional(),
    build: z.string().max(100),
  })
  .strict();
export const CapabilitySchema = z.enum([
  'CONTACTS_READ',
  'CONTACTS_WRITE',
  'CONVERSATIONS_WRITE',
  'CONVERSATIONS_READ',
  'DIALOGUE_SYNC',
  'BATCH_SYNC',
  'REFERENCES_WRITE',
  'REVIEW_ACK',
  'SEND',
  'OPERATIONS_READ',
  'MAINTENANCE_WRITE',
]);
export const ManagementRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('SUMMARY') }).strict(),
  z
    .object({
      operation: z.literal('CONTACTS'),
      query: z.record(z.string(), z.string()).default({}),
    })
    .strict(),
  z.object({ operation: z.literal('CONTACT_GET'), id: z.uuid() }).strict(),
  z.object({ operation: z.literal('CONTACT_CREATE'), input: ContactCreateSchema }).strict(),
  z
    .object({ operation: z.literal('CONTACT_UPDATE'), id: z.uuid(), input: ContactUpdateSchema })
    .strict(),
  z.object({ operation: z.literal('CANDIDATES'), query: CandidateQuerySchema }).strict(),
  z.object({ operation: z.literal('REFERENCE_DECIDE'), input: CandidateDecisionSchema }).strict(),
  z.object({ operation: z.literal('POLICY_GET'), id: z.uuid() }).strict(),
  z
    .object({ operation: z.literal('POLICY_UPDATE'), id: z.uuid(), input: PolicyUpdateSchema })
    .strict(),
  z
    .object({
      operation: z.literal('BATCH_REPORT'),
      id: z.uuid(),
      cursor: z.coerce.number().int().min(0).max(4999).optional(),
    })
    .strict(),
  z
    .object({ operation: z.literal('BATCH_RETRY'), id: z.uuid(), input: RetryBatchFailuresSchema })
    .strict(),
  z
    .object({
      operation: z.literal('BATCH_CANCEL'),
      id: z.uuid(),
      input: z.object({ explicitAuthorization: z.literal(true) }).strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('BATCH_RESUME'),
      id: z.uuid(),
      input: z
        .object({
          explicitAuthorization: z.literal(true),
          retryFailedItem: z.boolean().default(false),
        })
        .strict(),
    })
    .strict(),
  z.object({ operation: z.literal('SEND_QUEUE') }).strict(),
  z.object({ operation: z.literal('SEND_STATUS'), id: z.uuid() }).strict(),
  z.object({ operation: z.literal('SEND_SETTINGS_GET') }).strict(),
  z
    .object({ operation: z.literal('SEND_SETTINGS_UPDATE'), input: SendTimingOverrideSchema })
    .strict(),
  z.object({ operation: z.literal('SEND_CANCEL'), id: z.uuid() }).strict(),
  z.object({ operation: z.literal('MAINTENANCE_GET') }).strict(),
  z.object({ operation: z.literal('MAINTENANCE_UPDATE'), input: MaintenanceUpdateSchema }).strict(),
  z.object({ operation: z.literal('BACKUP_RUN'), explicitConfirmation: z.literal(true) }).strict(),
]);
export type ManagementRequest = z.infer<typeof ManagementRequestSchema>;
/** Closed route map shared by Native Messaging and MCP; never accepts a caller-supplied URL. */
export function managementRoute(raw: unknown): {
  path: string;
  method: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
} {
  const request = ManagementRequestSchema.parse(raw);
  const query = (value: object) =>
    new URLSearchParams(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, String(v)]),
    ).toString();
  switch (request.operation) {
    case 'SUMMARY':
      return { path: '/api/operations', method: 'GET' };
    case 'CONTACTS':
      return { path: '/api/contacts/directory?' + query(request.query), method: 'GET' };
    case 'CONTACT_GET':
      return { path: `/api/contact-catalog/${request.id}`, method: 'GET' };
    case 'CONTACT_CREATE':
      return { path: '/api/contact-catalog', method: 'POST', body: request.input };
    case 'CONTACT_UPDATE':
      return { path: `/api/contact-catalog/${request.id}`, method: 'PATCH', body: request.input };
    case 'CANDIDATES':
      return { path: '/api/reference-candidates?' + query(request.query), method: 'GET' };
    case 'REFERENCE_DECIDE':
      return { path: '/api/reference-candidates/decisions', method: 'POST', body: request.input };
    case 'POLICY_GET':
      return { path: `/api/conversation-policies/${request.id}`, method: 'GET' };
    case 'POLICY_UPDATE':
      return {
        path: `/api/conversation-policies/${request.id}`,
        method: 'POST',
        body: request.input,
      };
    case 'BATCH_REPORT':
      return {
        path:
          `/api/dialogue-sync-batches/${request.id}/report?` + query({ cursor: request.cursor }),
        method: 'GET',
      };
    case 'BATCH_RETRY':
    case 'BATCH_CANCEL':
    case 'BATCH_RESUME':
      return {
        path: `/api/dialogue-sync-batches/${request.id}/${request.operation === 'BATCH_RETRY' ? 'retry-failed' : request.operation === 'BATCH_CANCEL' ? 'cancel' : 'resume'}`,
        method: 'POST',
        body: request.input,
      };
    case 'SEND_QUEUE':
      return { path: '/api/extension/outbox/queue', method: 'GET' };
    case 'SEND_STATUS':
      return { path: `/api/extension/outbox/${request.id}`, method: 'GET' };
    case 'SEND_SETTINGS_GET':
      return { path: '/api/extension/send-settings', method: 'GET' };
    case 'SEND_SETTINGS_UPDATE':
      return { path: '/api/extension/send-settings', method: 'PATCH', body: request.input };
    case 'SEND_CANCEL':
      return { path: `/api/extension/outbox/${request.id}/cancel`, method: 'POST', body: {} };
    case 'MAINTENANCE_GET':
      return { path: '/api/maintenance', method: 'GET' };
    case 'MAINTENANCE_UPDATE':
      return { path: '/api/maintenance', method: 'POST', body: request.input };
    case 'BACKUP_RUN':
      return {
        path: '/api/maintenance/backup',
        method: 'POST',
        body: { explicitConfirmation: request.explicitConfirmation },
      };
  }
}
export const ReferenceCandidatePageSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            leftId: z.uuid(),
            rightId: z.uuid(),
            leftTitle: z.string().nullable(),
            rightTitle: z.string().nullable(),
            reason: z.enum(['PHONE_MATCH', 'NAME_MATCH']),
          })
          .strict(),
      )
      .max(100),
    nextCursor: CandidateQuerySchema.shape.cursor.unwrap().nullable(),
    historiesMerged: z.literal(false),
  })
  .strict();
export const BackupRunSchema = z
  .object({
    id: z.uuid(),
    fileName: z.string().max(256),
    status: z.enum(['RUNNING', 'VERIFIED', 'FAILED', 'PRUNED']),
    createdAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
    sizeBytes: z.number().int().nonnegative().nullable(),
    code: z.string().nullable(),
  })
  .strict();
export const MaintenanceStatusSchema = z
  .object({ policy: MaintenancePolicySchema, runs: BackupRunSchema.array().max(20) })
  .strict();
export const BackupResultSchema = z
  .object({ id: z.uuid(), fileName: z.string().max(256), status: z.literal('VERIFIED') })
  .strict();
export const OperationSummarySchema = z
  .object({
    coverageComplete: z.literal(false),
    counts: z
      .object({
        contacts: z.number().int().nonnegative(),
        pending: z.number().int().nonnegative(),
        failedBatches: z.number().int().nonnegative(),
        unprojectedCaptures: z.number().int().nonnegative(),
        failedCaptures: z.number().int().nonnegative(),
      })
      .strict(),
    batches: z
      .array(
        z
          .object({
            id: z.uuid(),
            status: z.string(),
            reason: z.string().nullable(),
            createdAt: z.iso.datetime(),
          })
          .strict(),
      )
      .max(20),
    lastSync: z.object({ at: z.iso.datetime().nullable() }).strict(),
    telemetry: z
      .array(
        ExtensionTelemetrySchema.extend({
          id: z.uuid(),
          updatedAt: z.iso.datetime(),
          stale: z.boolean(),
        }).strict(),
      )
      .max(10),
    maintenance: MaintenanceStatusSchema,
  })
  .strict();
