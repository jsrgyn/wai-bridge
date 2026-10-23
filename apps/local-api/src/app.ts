import { OperationsRepository, DialogueSyncBatchRepository } from '@wai-bridge/database';
import {
  ContactCreateSchema,
  ContactUpdateSchema,
  CandidateQuerySchema,
  CandidateDecisionSchema,
  PolicyUpdateSchema,
  MaintenanceUpdateSchema,
  ExtensionTelemetrySchema,
  RetryBatchFailuresSchema,
} from '@wai-bridge/shared';
import {
  ContactDirectoryQuerySchema,
  DialogueSyncBatchRequestSchema,
  DialogueSyncBatchPageQuerySchema,
  DialogueSyncBatchActionSchema,
  DialogueSyncBatchResumeSchema,
} from '@wai-bridge/shared';
import {
  ConversationReviewQuerySchema,
  ConversationReviewAckSchema,
  ConversationReviewLinkSchema,
  DialogueSyncRequestSchema,
  DialogueSyncPollSchema,
  DialogueSyncCompletionSchema,
} from '@wai-bridge/shared';
import { FlowLogRepository } from '@wai-bridge/database';
import { FlowLogBatchSchema, FlowLogQuerySchema, flowCode } from '@wai-bridge/shared';
import {
  ExtensionPhoneSendRequestSchema,
  ExtensionRecipientSendRequestSchema,
  ExtensionSendRequestSchema,
  SendTimingOverrideSchema,
  ExtensionSendPollSchema,
  ExtensionSendProgressSchema,
} from '@wai-bridge/shared';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import type { OutboxDispatcher } from '@wai-bridge/outbox-engine';
import { z } from 'zod';
import { ApiController } from './controllers/api-controller.js';
import { ApiError, badRequest, unauthorized } from './errors.js';
import {
  AckBodySchema,
  ExtensionStateSchema,
  CaptureBodySchema,
  ClaimBodySchema,
  ConsumerClaimBodySchema,
  ConsumerFailBodySchema,
  IdParamsSchema,
  IdempotencyKeySchema,
  MessageQuerySchema,
  OutboxBodySchema,
  OutboxResultSchema,
  PageQuerySchema,
  SearchQuerySchema,
} from './schemas.js';
import { ApiService } from './services/api-service.js';
export interface AppOptions {
  readonly db: Database.Database;
  readonly apiToken: string;
  readonly logger?: boolean;
  readonly maintenance?: import('@wai-bridge/database').MaintenanceService;
  readonly outboxDispatcher?: OutboxDispatcher;
}
function bearerMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw badRequest('Request validation failed');
  return result.data;
}
function sendError(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof ApiError)
    return reply
      .code(error.statusCode)
      .send({ error: { code: error.code, message: error.message, correlationId: request.id } });
  if (error instanceof z.ZodError)
    return reply.code(400).send({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        correlationId: request.id,
      },
    });
  request.log.error({ code: flowCode(error) }, 'Request failed');
  return reply.code(500).send({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      correlationId: request.id,
    },
  });
}
export function buildApp(options: AppOptions): FastifyInstance {
  if (options.apiToken.length < 32)
    throw new Error('API token must contain at least 32 characters');
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: 'info',
            redact: {
              paths: ['req.headers.authorization', 'req.headers.cookie', 'req.url', 'req.body'],
              censor: '[REDACTED]',
            },
          },
    bodyLimit: 64 * 1024,
    genReqId: () => randomUUID(),
  });
  app.addHook('onClose', async () => {
    await options.maintenance?.stop();
  });
  const operations = new OperationsRepository(options.db);
  const batches = new DialogueSyncBatchRepository(options.db);
  const service = new ApiService(options.db, (id) => options.outboxDispatcher?.cancelWait(id));
  const controller = new ApiController(service);
  const flowLogs = new FlowLogRepository(options.db);
  const failures = new WeakMap<FastifyRequest, ReturnType<typeof flowCode>>();
  const requests = new WeakMap<
    FastifyRequest,
    { traceId: string; start: number; resourceId?: string }
  >();
  const traceFor = (request: FastifyRequest) => {
    const parsed = z.uuid().safeParse(request.headers['x-wai-trace-id']);
    return parsed.success ? parsed.data : request.id;
  };
  app.addHook('onResponse', async (request, reply) => {
    const context = requests.get(request);
    if (!context) return;
    flowLogs.record({
      traceId: context.traceId,
      ...(context.resourceId ? { resourceId: context.resourceId } : {}),
      component: 'API',
      phase: 'API_REQUEST',
      outcome: reply.statusCode >= 400 ? 'FAILED' : 'SUCCEEDED',
      code: reply.statusCode >= 400 ? (failures.get(request) ?? 'HTTP_ERROR') : 'OK',
      durationMs: Math.max(0, Math.round(performance.now() - context.start)),
    });
  });
  app.setErrorHandler((error, request, reply) => {
    failures.set(request, flowCode(error instanceof ApiError ? error.code : error));
    return sendError(error, request, reply);
  });
  app.setNotFoundHandler((request, reply) =>
    sendError(new ApiError(404, 'NOT_FOUND', 'Route not found'), request, reply),
  );
  let outboxWorker: Promise<void> | undefined;
  if (options.outboxDispatcher) {
    app.addHook('onReady', async () => {
      outboxWorker = options.outboxDispatcher?.run() ?? Promise.resolve();
    });
    app.addHook('onClose', async () => {
      options.outboxDispatcher?.stop();
    });
    app.addHook('onClose', async () => {
      await outboxWorker;
    });
  }
  app.addHook('onClose', async () => {
    if (options.db.open) options.db.close();
  });
  app.get('/health', async () => ({ status: 'ok' }));
  app.register(
    async (api) => {
      api.addHook('preHandler', async (request, reply) => {
        if (!bearerMatches(request.headers.authorization, options.apiToken)) throw unauthorized();
        const route = request.routeOptions.url;
        if (
          !route?.startsWith('/api/diagnostics/') &&
          route !== '/api/extension/outbox/poll' &&
          route !== '/api/extension/dialogue-sync/poll' &&
          route !== '/api/extension/state'
        ) {
          const raw = request.body as
            { commandId?: unknown; observation?: { observationId?: unknown } } | undefined;
          const resource = z
            .uuid()
            .safeParse(
              raw?.commandId ??
                raw?.observation?.observationId ??
                (request.params as { id?: unknown })?.id,
            );
          const context = {
            traceId: traceFor(request),
            start: performance.now(),
            ...(resource.success ? { resourceId: resource.data } : {}),
          };
          requests.set(request, context);
          reply.header('x-wai-trace-id', context.traceId);
          flowLogs.record({
            traceId: context.traceId,
            ...(resource.success ? { resourceId: resource.data } : {}),
            component: 'API',
            phase: 'API_REQUEST',
            outcome: 'STARTED',
            code: 'STARTED',
          });
        }
      });
      api.post('/diagnostics/logs', async (request, reply) =>
        reply.code(202).send(flowLogs.append(parse(FlowLogBatchSchema, request.body))),
      );
      api.get('/diagnostics/logs', async (request) =>
        flowLogs.list(parse(FlowLogQuerySchema, request.query)),
      );
      const managed = <T>(work: () => T): T => {
        try {
          return work();
        } catch (error) {
          if (error instanceof z.ZodError) throw error;
          const code = error instanceof Error ? error.message : 'OPERATION_FAILED';
          if (/^[A-Z_]+$/.test(code))
            throw new ApiError(
              code.endsWith('NOT_FOUND') ? 404 : 409,
              code,
              'Operation could not be completed',
            );
          throw error;
        }
      };
      api.post('/contact-catalog', async (request, reply) =>
        reply
          .code(201)
          .send(managed(() => operations.create(parse(ContactCreateSchema, request.body)))),
      );
      api.get('/contact-catalog/:id', async (request) =>
        managed(() => operations.contact(parse(IdParamsSchema, request.params).id)),
      );
      api.patch('/contact-catalog/:id', async (request) =>
        managed(() =>
          operations.update(
            parse(IdParamsSchema, request.params).id,
            parse(ContactUpdateSchema, request.body),
          ),
        ),
      );
      api.get('/reference-candidates', async (request) =>
        managed(() => operations.candidates(parse(CandidateQuerySchema, request.query))),
      );
      api.post('/reference-candidates/decisions', async (request) =>
        managed(() => operations.decide(parse(CandidateDecisionSchema, request.body))),
      );
      api.get('/conversation-policies/:id', async (request) =>
        managed(() => operations.policy(parse(IdParamsSchema, request.params).id)),
      );
      api.post('/conversation-policies/:id', async (request) =>
        managed(() =>
          operations.setPolicy(
            parse(IdParamsSchema, request.params).id,
            parse(PolicyUpdateSchema, request.body),
          ),
        ),
      );
      api.get('/operations', async () => ({
        ...operations.summary(),
        runtime: controller.status(),
      }));
      api.post('/maintenance/backup', async (request) => {
        parse(z.object({ explicitConfirmation: z.literal(true) }).strict(), request.body);
        if (!options.maintenance)
          throw new ApiError(503, 'MAINTENANCE_UNAVAILABLE', 'Backup service unavailable');
        return options.maintenance.run();
      });
      api.get('/maintenance', async () => operations.maintenance());
      api.post('/maintenance', async (request) =>
        operations.setMaintenance(parse(MaintenanceUpdateSchema, request.body)),
      );
      api.post('/extension-telemetry/:id', async (request) =>
        operations.telemetry(
          parse(IdParamsSchema, request.params).id,
          parse(ExtensionTelemetrySchema, request.body),
        ),
      );
      api.get('/dialogue-sync-batches/:id/report', async (request) =>
        managed(() =>
          batches.report(
            parse(IdParamsSchema, request.params).id,
            parse(DialogueSyncBatchPageQuerySchema, request.query),
          ),
        ),
      );
      api.post('/dialogue-sync-batches/:id/retry-failed', async (request, reply) =>
        reply
          .code(202)
          .send(
            managed(() =>
              batches.retryFailed(
                parse(IdParamsSchema, request.params).id,
                parse(RetryBatchFailuresSchema, request.body),
              ),
            ),
          ),
      );
      api.get('/contacts/directory', async (request) =>
        controller.listContactDirectory(parse(ContactDirectoryQuerySchema, request.query)),
      );
      api.post('/dialogue-sync-batches', async (request, reply) =>
        reply
          .code(202)
          .send(
            controller.requestDialogueBatch(parse(DialogueSyncBatchRequestSchema, request.body)),
          ),
      );
      api.get('/dialogue-sync-batches/:id', async (request) =>
        controller.dialogueBatch(
          parse(IdParamsSchema, request.params).id,
          parse(DialogueSyncBatchPageQuerySchema, request.query),
        ),
      );
      api.post('/dialogue-sync-batches/:id/cancel', async (request) =>
        controller.cancelDialogueBatch(
          parse(IdParamsSchema, request.params).id,
          parse(DialogueSyncBatchActionSchema, request.body),
        ),
      );
      api.post('/dialogue-sync-batches/:id/resume', async (request) =>
        controller.resumeDialogueBatch(
          parse(IdParamsSchema, request.params).id,
          parse(DialogueSyncBatchResumeSchema, request.body),
        ),
      );
      api.get('/conversation-reviews', async (request) =>
        controller.listConversationReviews(parse(ConversationReviewQuerySchema, request.query)),
      );
      api.get('/conversation-reviews/:id', async (request) =>
        controller.conversationReview(parse(IdParamsSchema, request.params).id),
      );
      api.post('/conversation-reviews/:id/ack', async (request) =>
        controller.acknowledgeConversationReview(
          parse(IdParamsSchema, request.params).id,
          parse(ConversationReviewAckSchema, request.body),
        ),
      );
      api.post('/conversation-reviews/:id/links', async (request) =>
        controller.linkConversationReview(
          parse(IdParamsSchema, request.params).id,
          parse(ConversationReviewLinkSchema, request.body),
        ),
      );
      api.post('/dialogue-sync', async (request, reply) =>
        reply
          .code(202)
          .send(controller.requestDialogueSync(parse(DialogueSyncRequestSchema, request.body))),
      );
      api.get('/dialogue-sync/:id/messages', async (request) =>
        controller.dialogueSyncMessages(parse(IdParamsSchema, request.params).id),
      );
      api.get('/dialogue-sync/:id', async (request) =>
        controller.dialogueSyncStatus(parse(IdParamsSchema, request.params).id),
      );
      api.post('/extension/dialogue-sync/poll', async (request) =>
        controller.pollDialogueSync(parse(DialogueSyncPollSchema, request.body)),
      );
      api.post(
        '/extension/dialogue-sync/complete',
        { bodyLimit: 4 * 1024 * 1024 },
        async (request) =>
          controller.completeDialogueSync(parse(DialogueSyncCompletionSchema, request.body)),
      );
      api.get('/status', async () => controller.status());
      api.post('/extension/state', async (request, reply) => {
        const state = parse(ExtensionStateSchema, request.body);
        controller.recordExtensionState(state);
        return reply.code(204).send();
      });
      api.post('/observations', async (request, reply) => {
        const input = parse(CaptureBodySchema, request.body);
        return reply.code(202).send(controller.recordObservation(input));
      });
      api.get('/observations/:id', async (request) =>
        controller.observation(parse(IdParamsSchema, request.params).id),
      );
      api.get('/contacts', async (request) =>
        controller.contacts(parse(PageQuerySchema, request.query)),
      );
      api.get('/contacts/search', async (request) =>
        controller.searchContacts(parse(SearchQuerySchema, request.query)),
      );
      api.get('/conversations', async (request) =>
        controller.conversations(
          parse(
            PageQuerySchema.extend({ q: z.string().trim().min(2).max(100).optional() }),
            request.query,
          ),
        ),
      );
      api.get('/conversations/:id', async (request) =>
        controller.conversation(parse(IdParamsSchema, request.params).id),
      );
      api.get('/conversations/:id/capture-coverage', async (request) =>
        controller.captureCoverage(parse(IdParamsSchema, request.params).id),
      );
      api.get('/conversations/:id/messages', async (request) =>
        controller.conversationMessages(
          parse(IdParamsSchema, request.params).id,
          parse(PageQuerySchema, request.query),
        ),
      );
      api.get('/messages/unread', async (request) =>
        controller.unread(parse(PageQuerySchema, request.query)),
      );
      api.get('/messages/recent', async (request) =>
        controller.recent(parse(PageQuerySchema, request.query)),
      );
      api.get('/messages', async (request) =>
        controller.messages(parse(MessageQuerySchema, request.query)),
      );
      api.get('/media/:id', async (request) =>
        controller.media(parse(IdParamsSchema, request.params).id),
      );
      api.get('/events/pending', async (request) =>
        controller.events(parse(PageQuerySchema, request.query), true),
      );
      api.get('/events', async (request) =>
        controller.events(parse(PageQuerySchema, request.query)),
      );
      api.post('/ai/claims', async (request, reply) => {
        parse(IdempotencyKeySchema, request.headers['idempotency-key']);
        return reply.code(200).send(controller.claim(parse(ClaimBodySchema, request.body)));
      });
      api.post('/ai/ack', async (request, reply) => {
        parse(IdempotencyKeySchema, request.headers['idempotency-key']);
        return reply.code(200).send(controller.ack(parse(AckBodySchema, request.body)));
      });
      api.get('/ai/consumers/:consumerId/recoverable', async (request) => {
        const params = z
          .object({ consumerId: z.string().trim().min(1).max(128) })
          .parse(request.params);
        const query = parse(PageQuerySchema, request.query);
        return controller.recoverableMessages(params.consumerId, query.limit);
      });
      api.get('/ai/messages/:messageId/state', async (request) => {
        const params = z.object({ messageId: z.uuid() }).parse(request.params);
        const query = z
          .object({ consumerId: z.string().trim().min(1).max(128) })
          .strict()
          .parse(request.query);
        return controller.consumerMessageState(params.messageId, query.consumerId);
      });
      api.post('/ai/consumer-claims', async (request, reply) => {
        parse(IdempotencyKeySchema, request.headers['idempotency-key']);
        return reply.send(
          controller.claimForConsumer(parse(ConsumerClaimBodySchema, request.body)),
        );
      });
      api.post('/ai/consumer-ack', async (request, reply) => {
        parse(IdempotencyKeySchema, request.headers['idempotency-key']);
        return reply.send(controller.acknowledgeForConsumer(parse(AckBodySchema, request.body)));
      });
      api.post('/ai/consumer-fail', async (request, reply) => {
        parse(IdempotencyKeySchema, request.headers['idempotency-key']);
        return reply.send(controller.failForConsumer(parse(ConsumerFailBodySchema, request.body)));
      });
      api.post('/extension/outbox', async (request, reply) => {
        const key = parse(IdempotencyKeySchema, request.headers['idempotency-key']);
        return reply
          .code(202)
          .send(
            service.createExtensionSend(
              parse(ExtensionSendRequestSchema, request.body),
              key,
              traceFor(request),
            ),
          );
      });
      api.post('/extension/outbox/phone', async (request, reply) => {
        const key = parse(IdempotencyKeySchema, request.headers['idempotency-key']);
        return reply
          .code(202)
          .send(
            service.createExtensionPhoneSend(
              parse(ExtensionPhoneSendRequestSchema, request.body),
              key,
              traceFor(request),
            ),
          );
      });
      api.post('/extension/outbox/recipient', async (request, reply) => {
        const key = parse(IdempotencyKeySchema, request.headers['idempotency-key']);
        return reply
          .code(202)
          .send(
            service.createExtensionRecipientSend(
              parse(ExtensionRecipientSendRequestSchema, request.body),
              key,
              traceFor(request),
            ),
          );
      });
      api.post('/extension/outbox/poll', async (request) =>
        service.pollExtensionSend(parse(ExtensionSendPollSchema, request.body)),
      );
      api.post('/extension/outbox/progress', async (request) =>
        service.progressExtensionSend(parse(ExtensionSendProgressSchema, request.body)),
      );
      api.get('/extension/outbox/queue', async () => service.extensionSendQueue());
      api.get('/extension/outbox/:id', async (request) =>
        service.extensionSendStatus(parse(IdParamsSchema, request.params).id),
      );
      api.get('/extension/send-settings', async () => service.sendSettings());
      api.patch('/extension/send-settings', async (request) =>
        service.updateSendSettings(parse(SendTimingOverrideSchema, request.body)),
      );
      api.post('/extension/outbox/:id/cancel', async (request) =>
        service.cancelExtensionSend(parse(IdParamsSchema, request.params).id),
      );
      api.post('/outbox', async (request, reply) => {
        const key = parse(IdempotencyKeySchema, request.headers['idempotency-key']);
        return reply
          .code(202)
          .send(controller.createOutbox(parse(OutboxBodySchema, request.body), key));
      });
      api.get('/outbox', async (request) =>
        controller.outbox(parse(PageQuerySchema, request.query)),
      );
      api.get('/outbox/:id', async (request) =>
        controller.outboxItem(parse(IdParamsSchema, request.params).id),
      );
      api.post('/outbox/:id/cancel', async (request, reply) => {
        parse(IdempotencyKeySchema, request.headers['idempotency-key']);
        return reply.send(controller.cancelOutbox(parse(IdParamsSchema, request.params).id));
      });
      api.post('/outbox/:id/result', async (request, reply) => {
        const id = parse(IdParamsSchema, request.params).id;
        parse(IdempotencyKeySchema, request.headers['idempotency-key']);
        const result = parse(OutboxResultSchema, request.body);
        return reply.send(
          controller.recordOutboxResult(
            id,
            result.result,
            ...(result.evidenceRef ? [result.evidenceRef] : []),
          ),
        );
      });
    },
    { prefix: '/api' },
  );
  return app;
}
