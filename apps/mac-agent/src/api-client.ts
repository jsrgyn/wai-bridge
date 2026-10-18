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

  async sendPoll(input: unknown) {
    const result = ExtensionSendPollResultSchema.parse(
      await this.sendRequest('poll', ExtensionSendPollSchema.parse(input)),
    );
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
      if (!response.ok) throw new Error('HTTP_ERROR');
      const result = await response.json();
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
