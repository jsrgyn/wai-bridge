import { FlowLogRepository } from '@wai-bridge/database';
import { FlowLogBatchSchema, FlowLogQuerySchema, flowCode } from '@wai-bridge/shared';
import {
  ExtensionPhoneSendRequestSchema,
  ExtensionRecipientSendRequestSchema,
  ExtensionSendRequestSchema,
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
          route !== '/api/extension/state'
        ) {
          const raw = request.body as
            { commandId?: unknown; observation?: { observationId?: unknown } } | undefined;
          const resource = z.uuid().safeParse(raw?.commandId ?? raw?.observation?.observationId);
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
        controller.conversations(parse(PageQuerySchema, request.query)),
      );
      api.get('/conversations/:id', async (request) =>
        controller.conversation(parse(IdParamsSchema, request.params).id),
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
