import { managementRoute, ExtensionTelemetrySchema } from '@wai-bridge/shared';
import {
  DialogueSyncPollSchema,
  DialogueSyncPollResultSchema,
  DialogueSyncCompletionSchema,
  DialogueSyncResultSchema,
} from '@wai-bridge/shared';
import { z } from 'zod';
import { BufferedFlowReporter, emitFlow, flowCode, type FlowLogInput } from '@wai-bridge/shared';
import {
  ExtensionSendPollSchema,
  ExtensionSendProgressSchema,
  ExtensionSendPollResultSchema,
  ExtensionSendProgressResultSchema,
} from '@wai-bridge/shared';
import {
  CaptureResultSchema,
  CaptureSubmissionSchema,
  ExtensionStateInputSchema,
} from '@wai-bridge/shared';
import type { HostConfig } from './config.js';

/** The Local API speaks an incompatible send contract (older or newer build). */
export class ApiOutdatedError extends Error {
  constructor() {
    super('API_OUTDATED');
    this.name = 'ApiOutdatedError';
  }
}

export class LocalApiClient {
  private readonly reporter: BufferedFlowReporter;
  private lastNativeStatus: string | undefined;
  constructor(
    private readonly config: HostConfig,
    private readonly request: typeof fetch = fetch,
  ) {
    this.reporter = new BufferedFlowReporter(
      async (events) => {
        await this.recordFlowLogs(events);
      },
      (event) => process.stderr.write(JSON.stringify({ type: 'wai.flow', ...event }) + '\n'),
    );
  }
  log(input: FlowLogInput): void {
    emitFlow(this.reporter.emit, input);
  }
  async recordFlowLogs(events: unknown) {
    const response = await this.request(`${this.config.apiOrigin}/api/diagnostics/logs`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.apiToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ events }),
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) throw new Error('LOG_TRANSPORT_UNAVAILABLE');
    return z
      .object({
        accepted: z.number().int().min(0).max(50),
        inserted: z.number().int().min(0).max(50).optional(),
      })
      .strict()
      .parse(await response.json());
  }

  async management(raw: unknown) {
    const route = managementRoute(raw);
    const response = await this.request(`${this.config.apiOrigin}${route.path}`, {
      method: route.method,
      headers: {
        authorization: `Bearer ${this.config.apiToken}`,
        'content-type': 'application/json',
      },
      ...(route.body ? { body: JSON.stringify(route.body) } : {}),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => null)) as {
        error?: { code?: string };
      } | null;
      throw Error(data?.error?.code?.match(/^[A-Z_]+$/) ? data.error.code : 'MANAGEMENT_FAILED');
    }
    return z.json().parse(await response.json());
  }
  async telemetry(id: string, raw: unknown) {
    const input = ExtensionTelemetrySchema.parse(raw);
    const response = await this.request(
      `${this.config.apiOrigin}/api/extension-telemetry/${z.uuid().parse(id)}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.apiToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(2000),
      },
    );
    if (!response.ok) throw Error('TELEMETRY_UNAVAILABLE');
  }
  async syncPoll(input: unknown) {
    return DialogueSyncPollResultSchema.parse(
      await this.syncRequest('poll', DialogueSyncPollSchema.parse(input)),
    );
  }
  async syncComplete(input: unknown) {
    return DialogueSyncResultSchema.parse(
      await this.syncRequest('complete', DialogueSyncCompletionSchema.parse(input)),
    );
  }
  private async syncRequest(action: string, input: unknown) {
    const response = await this.request(
      `${this.config.apiOrigin}/api/extension/dialogue-sync/${action}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.apiToken}`,
          'content-type': 'application/json',
          ...((input as { requestId?: string }).requestId
            ? { 'x-wai-trace-id': (input as { requestId: string }).requestId }
            : {}),
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!response.ok) throw new Error('SYNC_API_UNAVAILABLE');
    return response.json();
  }
  async sendPoll(input: unknown) {
    const raw: unknown = await this.sendRequest('poll', ExtensionSendPollSchema.parse(input));
    const parsed = ExtensionSendPollResultSchema.safeParse(raw);
    if (!parsed.success) {
      // Never log the raw body (it may carry message text): only well-formed ids.
      const command = (raw as { command?: { id?: unknown; traceId?: unknown } } | null)?.command;
      const id = z.uuid().safeParse(command?.id);
      const trace = z.uuid().safeParse(command?.traceId);
      if (id.success)
        this.log({
          traceId: trace.success ? trace.data : id.data,
          resourceId: id.data,
          component: 'NATIVE_HOST',
          phase: 'SEND_CLAIMED',
          outcome: 'FAILED',
          code: 'API_CONTRACT_MISMATCH',
        });
      throw new ApiOutdatedError();
    }
    const result = parsed.data;
    if (result.command)
      this.log({
        traceId: result.command.traceId ?? result.command.id,
        resourceId: result.command.id,
        component: 'NATIVE_HOST',
        phase: 'SEND_CLAIMED',
        outcome: 'SUCCEEDED',
        code: 'OK',
      });
    return result;
  }
  async sendProgress(input: unknown) {
    return ExtensionSendProgressResultSchema.parse(
      await this.sendRequest('progress', ExtensionSendProgressSchema.parse(input)),
    );
  }
  private async sendRequest(action: string, body: unknown) {
    const traceInput = body as { traceId?: string; commandId?: string };
    const traceId = traceInput.traceId ?? traceInput.commandId ?? crypto.randomUUID();
    const start = performance.now();
    const logged = action === 'progress';
    if (logged)
      this.log({
        traceId,
        ...(traceInput.commandId ? { resourceId: traceInput.commandId } : {}),
        component: 'NATIVE_HOST',
        phase: 'HTTP_REQUEST',
        outcome: 'STARTED',
        code: 'STARTED',
      });
    try {
      const response = await this.request(
        `${this.config.apiOrigin}/api/extension/outbox/${action}`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.config.apiToken}`,
            'content-type': 'application/json',
            'x-wai-trace-id': traceId,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!response.ok) {
        if (action === 'poll' && response.status === 400) {
          const data = (await response.json().catch(() => null)) as {
            error?: { code?: unknown };
          } | null;
          // The API rejected our poll body: it predates the current protocol.
          if (data?.error?.code === 'VALIDATION_ERROR') throw new ApiOutdatedError();
        }
        throw new Error('HTTP_ERROR');
      }
      const result: unknown = await response.json();
      if (logged)
        this.log({
          traceId,
          ...(traceInput.commandId ? { resourceId: traceInput.commandId } : {}),
          component: 'NATIVE_HOST',
          phase: 'HTTP_REQUEST',
          outcome: 'SUCCEEDED',
          code: 'OK',
          durationMs: Math.round(performance.now() - start),
        });
      return result;
    } catch (error) {
      if (logged)
        this.log({
          traceId,
          ...(traceInput.commandId ? { resourceId: traceInput.commandId } : {}),
          component: 'NATIVE_HOST',
          phase: 'HTTP_REQUEST',
          outcome: 'FAILED',
          code:
            error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)
              ? 'TIMEOUT'
              : flowCode(error),
          durationMs: Math.round(performance.now() - start),
        });
      throw error;
    }
  }

  async health(): Promise<boolean> {
    try {
      const response = await this.request(`${this.config.apiOrigin}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async recordExtensionState(input: unknown): Promise<void> {
    const state = ExtensionStateInputSchema.parse(input);
    const response = await this.request(`${this.config.apiOrigin}/api/extension/state`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.apiToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(state),
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error(`API_STATE_WRITE_FAILED_${response.status}`);
    if (this.lastNativeStatus !== state.status) {
      this.lastNativeStatus = state.status;
      this.log({
        traceId: state.extensionInstanceId,
        resourceId: state.extensionInstanceId,
        component: 'NATIVE_HOST',
        phase: 'NATIVE_STATE',
        outcome: state.status === 'CONNECTED' ? 'SUCCEEDED' : 'WAITING',
        code: state.status,
      });
    }
  }

  async recordObservation(input: unknown) {
    const submission = CaptureSubmissionSchema.parse(input);
    const traceId = submission.observation.observationId;
    const start = performance.now();
    this.log({
      traceId,
      resourceId: traceId,
      component: 'NATIVE_HOST',
      phase: 'CAPTURE_FORWARDED',
      outcome: 'STARTED',
      code: 'STARTED',
    });
    try {
      const response = await this.request(`${this.config.apiOrigin}/api/observations`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.apiToken}`,
          'content-type': 'application/json',
          'x-wai-trace-id': traceId,
        },
        body: JSON.stringify(submission),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`API_CAPTURE_WRITE_FAILED_${response.status}`);
      const result = CaptureResultSchema.parse((await response.json()) as unknown);
      this.log({
        traceId,
        resourceId: traceId,
        component: 'NATIVE_HOST',
        phase: 'CAPTURE_ACK',
        outcome: 'SUCCEEDED',
        code: 'ACKNOWLEDGED',
        durationMs: Math.round(performance.now() - start),
      });
      return result;
    } catch (error) {
      this.log({
        traceId,
        resourceId: traceId,
        component: 'NATIVE_HOST',
        phase: 'CAPTURE_ACK',
        outcome: 'FAILED',
        code:
          error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)
            ? 'TIMEOUT'
            : flowCode(error),
        durationMs: Math.round(performance.now() - start),
      });
      throw error;
    }
  }
}
