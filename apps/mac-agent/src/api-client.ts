import { ExtensionSendPollSchema, ExtensionSendProgressSchema, ExtensionSendPollResultSchema, ExtensionSendProgressResultSchema } from '@wai-bridge/shared';
import { CaptureResultSchema, CaptureSubmissionSchema, ExtensionStateInputSchema } from '@wai-bridge/shared';
import type { HostConfig } from './config.js';

export class LocalApiClient {
  constructor(private readonly config: HostConfig, private readonly request: typeof fetch = fetch) {}

  async sendPoll(input: unknown) {
    return ExtensionSendPollResultSchema.parse(await this.sendRequest('poll',ExtensionSendPollSchema.parse(input)));
  }
  async sendProgress(input: unknown) {
    return ExtensionSendProgressResultSchema.parse(await this.sendRequest('progress',ExtensionSendProgressSchema.parse(input)));
  }
  private async sendRequest(action: string, body: unknown) {
    const response = await this.request(`${this.config.apiOrigin}/api/extension/outbox/${action}`, {
      method:'POST', headers:{authorization:`Bearer ${this.config.apiToken}`,'content-type':'application/json'},
      body:JSON.stringify(body), signal:AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('API_EXTENSION_SEND_FAILED');
    return response.json() as Promise<unknown>;
  }

  async health(): Promise<boolean> {
    try {
      const response = await this.request(`${this.config.apiOrigin}/health`, { signal: AbortSignal.timeout(3000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async recordExtensionState(input: unknown): Promise<void> {
    const state = ExtensionStateInputSchema.parse(input);
    const response = await this.request(`${this.config.apiOrigin}/api/extension/state`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.config.apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(state),
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error(`API_STATE_WRITE_FAILED_${response.status}`);
  }

  async recordObservation(input: unknown) {
    const submission = CaptureSubmissionSchema.parse(input);
    const response = await this.request(`${this.config.apiOrigin}/api/observations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.config.apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(submission),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`API_CAPTURE_WRITE_FAILED_${response.status}`);
    return CaptureResultSchema.parse(await response.json() as unknown);
  }
}
