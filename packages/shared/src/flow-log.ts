import { z } from 'zod';
export const FlowComponentSchema = z.enum([
  'MCP',
  'API',
  'NATIVE_HOST',
  'EXTENSION_BACKGROUND',
  'EXTENSION_CONTENT',
  'WHATSAPP_UI',
  'SQLITE',
]);
export const FlowPhaseSchema = z.enum([
  'MCP_TOOL',
  'HTTP_REQUEST',
  'API_REQUEST',
  'SEND_REQUESTED',
  'SEND_CLAIMED',
  'SEND_ACCEPTED',
  'RECIPIENT_LOOKUP',
  'CHAT_OPEN_STARTED',
  'CHAT_OPENED',
  'RECIPIENT_VERIFIED',
  'MESSAGE_COMPOSED',
  'WAITING_USER',
  'DRAFTED',
  'WAITING_AUTO_SEND',
  'SENDING',
  'SENT',
  'FAILED',
  'UNKNOWN',
  'CANCELLED',
  'SYNC_REQUESTED',
  'SYNC_CLAIMED',
  'SYNC_COMPLETED',
  'CAPTURE_OBSERVED',
  'CAPTURE_QUEUED',
  'CAPTURE_FORWARDED',
  'CAPTURE_COMMITTED',
  'CAPTURE_ACK',
  'CAPTURE_READ',
  'BRIDGE_STATE',
  'NATIVE_STATE',
]);
export const FlowCodeSchema = z.enum([
  'OK',
  'STARTED',
  'ACCEPTED',
  'QUEUED',
  'COMMITTED',
  'ACKNOWLEDGED',
  'REPLAY',
  'TIMEOUT',
  'HTTP_ERROR',
  'UNEXPECTED_ERROR',
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'NOT_FOUND',
  'API_UNAVAILABLE',
  'PROGRESS_UNAVAILABLE',
  'EXTENSION_CONTEXT_INVALIDATED',
  'CONTENT_UNREACHABLE',
  'CONTENT_OUTDATED',
  'API_OUTDATED',
  'CLIENT_OUTDATED',
  'API_CONTRACT_MISMATCH',
  'READY',
  'STALE',
  'NO_WHATSAPP_TAB',
  'NO_MONITORED_CONTEXT',
  'AMBIGUOUS_TABS',
  'TAB_HIDDEN',
  'SEND_DISABLED',
  'EXECUTING',
  'CONNECTED',
  'DISCONNECTED',
  'UNCONFIGURED',
  'AUTO_COUNTDOWN_STARTED',
  'MANUAL_SEND_REQUIRED',
  'SEND_CLICK_AUTHORIZED',
  'VISIBLE_OUTBOUND_CONFIRMED',
  'SEND_CONFIRMATION_TIMEOUT',
  'EXECUTION_UNCERTAIN',
  'RESULT_NOT_PERSISTED',
  'EXECUTOR_REJECTED',
  'USER_CANCELLED',
  'USER_INTERFERENCE',
  'RECIPIENT_ACCOUNT_MISMATCH',
  'RECIPIENT_PHONE_MISMATCH',
  'RECIPIENT_CONTEXT_MISMATCH',
  'RECIPIENT_IS_GROUP',
  'RECIPIENT_PHONE_REQUIRED',
  'RECIPIENT_NAME_NOT_FOUND',
  'AMBIGUOUS_RECIPIENT',
  'AMBIGUOUS_PHONE_RESULTS',
  'PHONE_CONTACT_NOT_FOUND',
  'PHONE_PROFILE_UNAVAILABLE',
  'PHONE_CHAT_UNAVAILABLE',
  'PHONE_PROFILE_CONTROL_UNAVAILABLE',
  'PHONE_RESULT_LABEL_UNAVAILABLE',
  'SEARCH_CONTROL_UNAVAILABLE',
  'SEARCH_HAS_INPUT',
  'SEARCH_CHANGED',
  'SEARCH_PANEL_BUSY',
  'SEARCH_RESULTS_NOT_READY',
  'PROFILE_HAS_INPUT',
  'PROFILE_CLOSE_UNAVAILABLE',
  'COMPOSER_HAS_DRAFT',
  'COMPOSER_CHANGED',
  'COMPOSER_UNAVAILABLE',
  'COMPOSE_FAILED',
  'CONVERSATION_UNAVAILABLE',
  'SEND_CONTROL_UNAVAILABLE',
  'SEND_CONTEXT_UNAVAILABLE',
  'EXTENSION_SENDS_DISABLED',
  'SEND_LEASE_EXPIRED',
  'WHATSAPP_TAB_NOT_VISIBLE',
  'ACTIVE_SEND_ACCOUNT_REQUIRED',
  'AMBIGUOUS_SEND_ACCOUNT',
  'SEND_LEASE_MISMATCH',
  'SEND_STATE_CONFLICT',
  'REQUEST_EXPIRED',
  'EXTENSION_LEASE_EXPIRED',
  'EXTENSION_ORPHANED',
  'EXTENSION_NO_ACK',
  'EXTENSION_INTERRUPTED_REQUEUED',
  'CAPTURE_QUEUE_FULL',
  'CAPTURE_REVISION_CONFLICT',
  'CAPTURE_DIRECTION_CONFLICT',
  'CAPTURE_QUEUE_UNAVAILABLE',
  'IDEMPOTENCY_CONFLICT',
]);
export const FlowToolSchema = z.enum([
  'whatsapp_list_contacts',
  'whatsapp_sync_pending_conversations',
  'whatsapp_get_sync_batch',
  'whatsapp_cancel_sync_batch',
  'whatsapp_resume_sync_batch',
  'whatsapp_list_pending_conversations',
  'whatsapp_get_conversation_review',
  'whatsapp_confirm_conversation_read',
  'whatsapp_link_conversation_references',
  'whatsapp_status',
  'whatsapp_get_flow_logs',
  'whatsapp_search_contacts',
  'whatsapp_list_conversations',
  'whatsapp_list_groups',
  'whatsapp_get_conversation',
  'whatsapp_sync_dialogue',
  'whatsapp_get_sync_status',
  'whatsapp_get_dialogue',
  'whatsapp_get_messages',
  'whatsapp_get_unread',
  'whatsapp_get_recent',
  'whatsapp_get_media',
  'whatsapp_get_pending_tasks',
  'whatsapp_send_message',
  'whatsapp_send_to_number',
  'whatsapp_send_to_contact',
  'whatsapp_cancel_extension_send',
  'whatsapp_prepare_message',
  'whatsapp_request_send',
  'whatsapp_get_outbox_status',
  'whatsapp_cancel_send',
]);
export const FlowLogSchema = z
  .object({
    id: z.uuid(),
    traceId: z.uuid(),
    resourceId: z.uuid().optional(),
    relatedTraceId: z.uuid().optional(),
    at: z.iso.datetime(),
    component: FlowComponentSchema,
    tool: FlowToolSchema.optional(),
    phase: FlowPhaseSchema,
    level: z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR']),
    outcome: z.enum(['STARTED', 'SUCCEEDED', 'WAITING', 'FAILED', 'CANCELLED', 'UNKNOWN']),
    code: FlowCodeSchema,
    direction: z.enum(['INBOUND', 'OUTBOUND', 'UNKNOWN']).optional(),
    mode: z.enum(['AUTO', 'SUPERVISED']).optional(),
    durationMs: z.number().int().min(0).max(86400000).optional(),
    attempt: z.number().int().min(0).max(100).optional(),
    build: z.union([z.literal('development'), z.iso.datetime()]).optional(),
  })
  .strict();
export type FlowLog = z.infer<typeof FlowLogSchema>;
export type FlowLogInput = Omit<FlowLog, 'id' | 'at' | 'level'> & { level?: FlowLog['level'] };
export type FlowLogSink = (event: FlowLog) => void;
export function flowCode(error: unknown): z.infer<typeof FlowCodeSchema> {
  const raw = error instanceof Error ? error.message.split(':')[0]?.trim() : error;
  if (
    raw === 'Extension sends are disabled in MCP configuration' ||
    raw === 'Write tools are disabled by MCP server configuration'
  )
    return 'SEND_DISABLED';
  return FlowCodeSchema.safeParse(raw).success ? FlowCodeSchema.parse(raw) : 'UNEXPECTED_ERROR';
}
export function makeFlowLog(input: FlowLogInput): FlowLog {
  return FlowLogSchema.parse({
    ...input,
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    level:
      input.level ??
      (input.outcome === 'FAILED' ? 'ERROR' : input.outcome === 'UNKNOWN' ? 'WARN' : 'INFO'),
  });
}
export function emitFlow(sink: FlowLogSink | undefined, input: FlowLogInput): void {
  try {
    sink?.(makeFlowLog(input));
  } catch {
    /* Telemetry must never change a business effect. */
  }
}
export const FlowLogBatchSchema = z
  .object({ events: z.array(FlowLogSchema).min(1).max(50) })
  .strict();
export const FlowLogQuerySchema = z
  .object({
    traceId: z.uuid().optional(),
    resourceId: z.uuid().optional(),
    component: FlowComponentSchema.optional(),
    level: z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR']).optional(),
    beforeSequence: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

/** Bounded best-effort transport; retries telemetry only, never a business operation. */
export class BufferedFlowReporter {
  private queue: FlowLog[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private busy = false;
  private stopped = false;
  private retryMs = 1000;
  constructor(
    private readonly send: (events: FlowLog[]) => Promise<void>,
    private readonly local?: FlowLogSink,
  ) {}
  readonly emit: FlowLogSink = (event) => {
    try {
      const value = FlowLogSchema.parse(event);
      this.local?.(value);
      this.queue.push(value);
      if (this.queue.length > 200) this.queue.shift();
      this.schedule(200);
    } catch {
      /* Never throw into a command. */
    }
  };
  private schedule(ms: number) {
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, ms);
    const handle: unknown = this.timer;
    if (
      typeof handle === 'object' &&
      handle !== null &&
      'unref' in handle &&
      typeof handle.unref === 'function'
    )
      handle.unref();
  }
  async flush(): Promise<void> {
    if (this.busy || this.stopped || !this.queue.length) return;
    this.busy = true;
    const batch = this.queue.slice(0, 50);
    try {
      await this.send(batch);
      const ids = new Set(batch.map((e) => e.id));
      this.queue = this.queue.filter((e) => !ids.has(e.id));
      this.retryMs = 1000;
    } catch {
      this.schedule(this.retryMs);
      this.retryMs = Math.min(10000, this.retryMs * 2);
    } finally {
      this.busy = false;
      if (this.queue.length) this.schedule(200);
    }
  }
  dispose() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
