import { ContactDirectoryRepository,DialogueSyncBatchRepository } from '@wai-bridge/database';
import { ConversationReviewRepository } from '@wai-bridge/database';
import { DialogueSyncRepository } from '@wai-bridge/database';
import { FlowLogRepository } from '@wai-bridge/database';
import { ExtensionSendRepository, SendSettingsRepository } from '@wai-bridge/database';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import {
  AIMessageStateRepository,
  ApiReadRepository,
  CommandRepository,
  OutboxRepository,
  ExtensionStateRepository,
  CaptureObservationRepository,
  CaptureNormalizationRepository,
} from '@wai-bridge/database';
import { EventRepository, EventService } from '@wai-bridge/events';
import { OutboxCancellationService, OutboxService } from '@wai-bridge/outbox-engine';
import type { CaptureObservation, SendTimingOverride } from '@wai-bridge/shared';
import { badRequest, conflict, notFound } from '../errors.js';
import type { PageQuery, MessageQuery } from '../types.js';
function decodeCursor(cursor: string | undefined): string | undefined {
  if (!cursor) return undefined;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!decoded || decoded.length > 128) throw new Error();
    return decoded;
  } catch {
    throw badRequest('Invalid cursor');
  }
}
function encodeCursor(value: string | number): string {
  return Buffer.from(String(value)).toString('base64url');
}
function page<T>(
  items: readonly T[],
  limit: number,
  key: (item: T) => string | number,
): { items: readonly T[]; nextCursor: string | null } {
  return {
    items,
    nextCursor: items.length === limit ? encodeCursor(key(items[items.length - 1]!)) : null,
  };
}
export class ApiService {
  private readonly reads: ApiReadRepository;
  private readonly commands: CommandRepository;
  private readonly outboxService: OutboxService;
  private readonly outboxRepository: OutboxRepository;
  private readonly outboxCancellation: OutboxCancellationService;
  private readonly reading: AIMessageStateRepository;
  private readonly eventRepository: EventRepository;
  private readonly extensionStates: ExtensionStateRepository;
  private readonly observations: CaptureObservationRepository;
  private readonly eventService: EventService;
  constructor(
    private readonly db: Database.Database,
    cancelOutboxWait: (id: string) => void = () => {},
  ) {
    this.reads = new ApiReadRepository(db);
    this.commands = new CommandRepository(db);
    this.outboxRepository = new OutboxRepository(db);
    this.outboxService = new OutboxService(this.outboxRepository);
    this.outboxCancellation = new OutboxCancellationService(this.outboxService, cancelOutboxWait);
    this.reading = new AIMessageStateRepository(db);
    this.eventRepository = new EventRepository(db);
    this.extensionStates = new ExtensionStateRepository(db);
    this.observations = new CaptureObservationRepository(db);
    this.eventService = new EventService(db);
  }
  listContactDirectory(input:unknown) { return new ContactDirectoryRepository(this.db).list(input); }
  requestDialogueBatch(input:unknown) { return this.batchOperation(()=>new DialogueSyncBatchRepository(this.db).create(input)); }
  dialogueBatch(id:string,input:unknown) { return this.batchOperation(()=>new DialogueSyncBatchRepository(this.db).page(id,input)); }
  cancelDialogueBatch(id:string,input:unknown) { return this.batchOperation(()=>new DialogueSyncBatchRepository(this.db).cancel(id,input)); }
  resumeDialogueBatch(id:string,input:unknown) { return this.batchOperation(()=>new DialogueSyncBatchRepository(this.db).resume(id,input)); }
  private batchOperation<T>(run:()=>T):T {
    try{return run();}catch(error){
      if(error instanceof Error && error.message.startsWith('BATCH_')){
        if(error.message==='BATCH_NOT_FOUND'||error.message==='BATCH_TARGET_NOT_FOUND')throw notFound('Batch or selected reference not found');
        throw conflict(error.message,'Dialogue batch could not be processed');
      }
      if(error instanceof Error && error.message==='IDEMPOTENCY_CONFLICT')throw conflict('IDEMPOTENCY_CONFLICT','Request key has different content');
      throw error;
    }
  }
  listConversationReviews(input: unknown) {
    return new ConversationReviewRepository(this.db).list(input);
  }
  conversationReview(id: string) {
    return this.reviewOperation(() => new ConversationReviewRepository(this.db).get(id));
  }
  acknowledgeConversationReview(id: string, input: unknown) {
    return this.reviewOperation(() => new ConversationReviewRepository(this.db).acknowledge(id, input));
  }
  linkConversationReview(id: string, input: unknown) {
    return this.reviewOperation(() => new ConversationReviewRepository(this.db).link(id, input));
  }
  private reviewOperation<T>(run: () => T): T {
    try { return run(); } catch (error) {
      if (error instanceof Error && error.message.startsWith('REVIEW_')) {
        if (error.message === 'REVIEW_NOT_FOUND') throw notFound('Conversation review not found');
        throw conflict(error.message, 'Conversation review could not be updated');
      }
      throw error;
    }
  }
  requestDialogueSync(input: unknown) {
    return this.syncOperation(() => new DialogueSyncRepository(this.db).create(input));
  }
  dialogueSyncStatus(id: string) {
    return this.syncOperation(() => new DialogueSyncRepository(this.db).get(id));
  }
  dialogueSyncMessages(id: string) {
    const sync = this.dialogueSyncStatus(id);
    if (sync.status !== 'SUCCEEDED' || !sync.conversationId)
      throw conflict('SYNC_NOT_COMPLETED', 'Sync is not committed');
    const messages = this.reads.messages({
      conversationId: sync.conversationId,
      messageIds: sync.messageIds,
      limit: 50,
    }) as Array<{ id: string }>;
    const byId = new Map(messages.map((m) => [m.id, m]));
    if (sync.messageIds.some((messageId) => !byId.has(messageId)))
      throw conflict('SYNC_MESSAGES_UNAVAILABLE', 'A synchronized message is no longer available');
    return { items: sync.messageIds.map((messageId) => byId.get(messageId)!), nextCursor: null };
  }
  pollDialogueSync(input: unknown) {
    return this.syncOperation(()=>{
      const batches=new DialogueSyncBatchRepository(this.db);batches.advance();
      const result=new DialogueSyncRepository(this.db).poll(input);
      if(result.job){const batch=batches.manifest(result.job.id);return {...result,job:{...result.job,...(batch?{batch}:{})}};}
      return result;
    });
  }
  completeDialogueSync(input: unknown) {
    return this.syncOperation(() =>
      new DialogueSyncRepository(this.db).complete(input, (observation, extensionInstanceId) => {
        this.recordObservation({ observation, extensionInstanceId }, false);
      }),
    );
  }
  private syncOperation<T>(run: () => T): T {
    try {
      return run();
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('SYNC_')) {
        if (error.message === 'SYNC_NOT_FOUND') throw notFound('Sync request not found');
        throw conflict(error.message, 'Dialogue sync could not be completed');
      }
      if (error instanceof Error && error.message === 'IDEMPOTENCY_CONFLICT')
        throw conflict('IDEMPOTENCY_CONFLICT', 'Request key has different content');
      throw error;
    }
  }
  status() {
    return {
      status: 'ok',
      database: 'connected',
      extension: new ExtensionSendRepository(this.db).diagnostics(),
      schemaVersion: (
        this.db.prepare('SELECT MAX(version) version FROM wa_schema_migrations').get() as {
          version: number | null;
        }
      ).version,
    };
  }
  recordExtensionState(input: {
    extensionInstanceId: string;
    status: 'CONNECTED' | 'DISCONNECTED';
    lastSeenAt: string;
  }) {
    this.extensionStates.record(input);
    return { recorded: true };
  }
  recordObservation(input: { extensionInstanceId: string; observation: CaptureObservation }, trackReview = true) {
    try {
      const tx = this.db.transaction(() => {
        const result = this.observations.record(
          input.extensionInstanceId,
          input.observation,
          (observation) => {
            const type =
              observation.observationType === 'CONVERSATION_ACTIVITY'
                ? 'conversation.detected'
                : observation.captureState === 'CAPTURED'
                  ? 'message.captured'
                  : 'message.detected';
            return this.eventService.publish({
              id: randomUUID(),
              type,
              aggregateType: 'capture-observation',
              aggregateId: observation.observationId,
              occurredAt: observation.observedAt,
              payloadVersion: 1,
              payload: {
                observationId: observation.observationId,
                captureState: observation.captureState,
                observationType: observation.observationType,
              },
              idempotencyScope: `capture-observation:${input.extensionInstanceId}`,
              idempotencyKey: observation.observationId,
            }).event.id;
          },
        );
        const normalized = new CaptureNormalizationRepository(this.db).normalize(
          input.extensionInstanceId,
          input.observation,
          trackReview,
        );
        if (normalized.created && normalized.messageId) {
          this.eventService.publish({
            id: randomUUID(),
            type:
              normalized.status === 'MESSAGE_UPDATED'
                ? 'message.updated'
                : input.observation.captureState === 'CAPTURED'
                  ? 'message.captured'
                  : 'message.detected',
            aggregateType: 'message',
            aggregateId: normalized.messageId,
            occurredAt: input.observation.observedAt,
            payloadVersion: 1,
            payload: {
              observationId: input.observation.observationId,
              conversationId: normalized.conversationId,
              identityStatus: input.observation.identity ? 'PARTIAL' : 'UNKNOWN',
            },
            idempotencyScope: `normalized-message:${input.extensionInstanceId}`,
            idempotencyKey: input.observation.observationId,
          });
        }
        return { observationId: input.observation.observationId, ...result };
      });
      const committed = tx.immediate();
      new FlowLogRepository(this.db).record({
        traceId: input.observation.observationId,
        resourceId: input.observation.observationId,
        component: 'SQLITE',
        phase: 'CAPTURE_COMMITTED',
        outcome: 'SUCCEEDED',
        code: committed.duplicate ? 'REPLAY' : 'COMMITTED',
      });
      return committed;
    } catch (error) {
      if (
        error instanceof Error &&
        ['CAPTURE_REVISION_CONFLICT', 'CAPTURE_DIRECTION_CONFLICT'].includes(error.message)
      )
        throw conflict(error.message, 'Observation revision does not match its original context');
      if (error instanceof Error && error.message === 'IDEMPOTENCY_CONFLICT')
        throw conflict('IDEMPOTENCY_CONFLICT', 'Observation ID has different content');
      throw error;
    }
  }
  observation(id: string) {
    const value = this.observations.get(id);
    if (!value) throw notFound('Observation');
    return value;
  }
  contacts(query: PageQuery) {
    const items = this.reads.contacts(decodeCursor(query.cursor), query.limit);
    return page(items, query.limit, (x) => String((x as { id: string }).id));
  }
  searchContacts(query: PageQuery & { q: string }) {
    const items = this.reads.searchContacts(query.q, decodeCursor(query.cursor), query.limit);
    return page(items, query.limit, (x) => String((x as { id: string }).id));
  }
  conversations(query: PageQuery & { q?: string | undefined }) {
    const items = this.reads.conversations(decodeCursor(query.cursor), query.limit, query.q);
    return page(items, query.limit, (x) => String((x as { id: string }).id));
  }
  conversation(id: string) {
    const item = this.reads.conversation(id);
    if (!item) throw notFound('Conversation');
    return item;
  }
  messages(query: MessageQuery) {
    const cursorValue = decodeCursor(query.cursor);
    let items;
    if (query.conversationId) {
      const afterSequence = cursorValue === undefined ? undefined : Number(cursorValue);
      if (
        afterSequence !== undefined &&
        (!Number.isSafeInteger(afterSequence) || afterSequence < 1)
      )
        throw badRequest('Invalid cursor');
      items = this.reads.messages({
        ...query,
        ...(afterSequence !== undefined ? { afterSequence } : {}),
      });
      return page(items, query.limit, (x) => String((x as { sequence: number }).sequence));
    }
    let afterObservedAt: string | undefined;
    let beforeId: string | undefined;
    if (cursorValue !== undefined) {
      const parts = cursorValue.split('|');
      if (
        parts.length !== 2 ||
        !parts[0] ||
        !z.iso.datetime().safeParse(parts[0]).success ||
        !z.uuid().safeParse(parts[1]).success
      )
        throw badRequest('Invalid cursor');
      [afterObservedAt, beforeId] = parts as [string, string];
    }
    items = this.reads.messages({
      ...query,
      ...(afterObservedAt && beforeId ? { afterObservedAt, beforeId } : {}),
    });
    return page(
      items,
      query.limit,
      (x) => `${(x as { observedAt: string }).observedAt}|${(x as { id: string }).id}`,
    );
  }
  recoverableMessages(consumerId: string, limit = 50) {
    return this.reading.listRecoverable(consumerId, new Date().toISOString(), limit);
  }
  consumerMessageState(messageId: string, consumerId: string) {
    const current = this.reading.getForConsumer(messageId, consumerId);
    return (
      current ?? {
        messageId,
        consumerId,
        state: 'UNREAD' as const,
        version: 0,
        leaseUntil: null,
        lastErrorCode: null,
      }
    );
  }
  claimForConsumer(messageId: string, consumerId: string, leaseMs: number) {
    return this.reading.claimForConsumer(messageId, consumerId, new Date().toISOString(), leaseMs);
  }
  acknowledgeForConsumer(messageId: string, consumerId: string, claimToken: string) {
    return this.reading.acknowledgeForConsumer(
      messageId,
      consumerId,
      claimToken,
      new Date().toISOString(),
    );
  }
  failForConsumer(messageId: string, consumerId: string, claimToken: string, errorCode: string) {
    this.reading.failForConsumer(
      messageId,
      consumerId,
      claimToken,
      errorCode,
      new Date().toISOString(),
    );
    return { state: 'FAILED' as const };
  }
  captureCoverage(id: string) {
    this.conversation(id);
    return this.reads.captureCoverage(id);
  }
  conversationMessages(id: string, query: PageQuery) {
    this.conversation(id);
    const cursorValue = decodeCursor(query.cursor);
    const afterSequence = cursorValue === undefined ? undefined : Number(cursorValue);
    if (afterSequence !== undefined && (!Number.isSafeInteger(afterSequence) || afterSequence < 1))
      throw badRequest('Invalid cursor');
    const items = this.reads.messages({
      conversationId: id,
      limit: query.limit,
      ...(afterSequence !== undefined ? { afterSequence } : {}),
    });
    return page(items, query.limit, (x) => String((x as { sequence: number }).sequence));
  }
  unread(query: PageQuery) {
    return this.messages({ ...query, aiState: 'UNREAD' });
  }
  recent(query: PageQuery) {
    return this.messages(query);
  }
  media(id: string) {
    const media = this.reads.media(id);
    if (!media) throw notFound('Media');
    return media;
  }
  events(query: PageQuery, pending = false) {
    const after = Number(decodeCursor(query.cursor) ?? '0');
    if (!Number.isSafeInteger(after) || after < 0) throw badRequest('Invalid event cursor');
    const items = pending
      ? this.eventRepository.listPending(after, query.limit)
      : this.eventRepository.listEvents(after, query.limit);
    return page(items, query.limit, (x) => x.sequence);
  }
  claim(messageId: string, consumerId: string) {
    try {
      return this.reading.claim(messageId, consumerId, new Date().toISOString());
    } catch (error) {
      if (error instanceof Error && error.message === 'Message state not found')
        throw notFound('Message');
      if (error instanceof Error && error.message === 'STATE_CONFLICT')
        throw conflict('STATE_CONFLICT', 'Message is not available to claim');
      throw error;
    }
  }
  acknowledge(messageId: string, consumerId: string, claimToken: string) {
    try {
      return this.reading.acknowledge(messageId, consumerId, claimToken, new Date().toISOString());
    } catch (error) {
      if (error instanceof Error && error.message === 'Message state not found')
        throw notFound('Message');
      if (error instanceof Error && error.message === 'ACK_FORBIDDEN')
        throw conflict('ACK_FORBIDDEN', 'Claim token or consumer does not match');
      throw error;
    }
  }
  createExtensionRecipientSend(input: unknown, key: string, traceId?: string) {
    return this.extensionSendCall(() =>
      new ExtensionSendRepository(this.db).createToName(input, key, traceId),
    );
  }
  createExtensionPhoneSend(input: unknown, key: string, traceId?: string) {
    return this.extensionSendCall(() =>
      new ExtensionSendRepository(this.db).createToNumber(input, key, undefined, traceId),
    );
  }
  createExtensionSend(input: unknown, key: string, traceId?: string) {
    return this.extensionSendCall(() =>
      new ExtensionSendRepository(this.db).create(input, key, traceId),
    );
  }
  pollExtensionSend(input: unknown) {
    return this.extensionSendCall(() => new ExtensionSendRepository(this.db).poll(input));
  }
  progressExtensionSend(input: unknown) {
    return this.extensionSendCall(() => new ExtensionSendRepository(this.db).progress(input));
  }
  cancelExtensionSend(id: string) {
    return this.extensionSendCall(() => new ExtensionSendRepository(this.db).cancel(id));
  }
  extensionSendQueue() {
    return new ExtensionSendRepository(this.db).queue();
  }
  extensionSendStatus(id: string) {
    try {
      return new ExtensionSendRepository(this.db).status(id);
    } catch (error) {
      if (error instanceof Error && error.message === 'COMMAND_NOT_FOUND')
        throw notFound('Command');
      throw error;
    }
  }
  sendSettings() {
    return new SendSettingsRepository(this.db).get();
  }
  updateSendSettings(input: SendTimingOverride) {
    return new SendSettingsRepository(this.db).update(input);
  }
  private extensionSendCall<T>(run: () => T): T {
    try {
      return run();
    } catch (error) {
      if (error instanceof Error && /^[A-Z0-9_]+$/.test(error.message))
        throw conflict(error.message, 'Extension send request rejected');
      throw error;
    }
  }
  createOutbox(
    input: {
      recipientId: string;
      text: string;
      mode: 'AUTO' | 'SUPERVISED';
      explicitAuthorization: true;
    },
    idempotencyKey: string,
  ) {
    if (!this.reads.contact(input.recipientId)) throw notFound('Contact');
    try {
      const result = this.outboxService.create(input, 'local-api', idempotencyKey);
      return { inserted: result.inserted, id: result.id, status: result.command.status };
    } catch (error) {
      if (error instanceof Error && error.message === 'IDEMPOTENCY_CONFLICT')
        throw conflict('IDEMPOTENCY_CONFLICT', 'Idempotency key was reused with different content');
      throw error;
    }
  }
  outbox(query: PageQuery) {
    new ExtensionSendRepository(this.db).recover();
    const items = this.commands.list(query.limit, decodeCursor(query.cursor));
    return page(items, query.limit, (x) => String((x as { id: string }).id));
  }
  outboxItem(id: string) {
    new ExtensionSendRepository(this.db).recover();
    const item = this.commands.get(id);
    if (!item) throw notFound('Command');
    const command = { ...(item as Record<string, unknown>) };
    if (command.kind === 'extension-send') delete command.lease_owner;
    return { command, history: this.outboxRepository.history(id) };
  }
  cancelOutbox(id: string) {
    if (this.outboxRepository.get(id)?.kind === 'extension-send') {
      this.cancelExtensionSend(id);
      return this.outboxItem(id);
    }
    try {
      this.outboxCancellation.cancel(id, 'local-api-user');
    } catch (error) {
      if (error instanceof Error && error.message === 'COMMAND_NOT_FOUND')
        throw notFound('Command');
      if (error instanceof Error && error.message === 'OUTBOX_CANNOT_CANCEL')
        throw conflict('STATE_CONFLICT', 'Command can no longer be cancelled');
      if (error instanceof Error && error.message === 'OUTBOX_STATE_CONFLICT')
        throw conflict('STATE_CONFLICT', 'Command can no longer be cancelled');
      throw error;
    }
    return this.outboxItem(id);
  }
  recordOutboxResult(id: string, result: 'SENT' | 'UNKNOWN' | 'FAILED', evidenceRef?: string) {
    if (this.outboxRepository.get(id)?.kind === 'extension-send')
      throw conflict('EXTENSION_RESULT_REQUIRED', 'Use the authenticated extension result channel');
    try {
      return this.outboxService.recordManualResult(id, result, evidenceRef);
    } catch (error) {
      if (error instanceof Error && error.message === 'COMMAND_NOT_FOUND')
        throw notFound('Command');
      if (
        error instanceof Error &&
        ['OUTBOX_STATE_CONFLICT', 'VERIFIED_EVIDENCE_REQUIRED'].includes(error.message)
      )
        throw conflict('STATE_CONFLICT', error.message);
      throw error;
    }
  }
}
