import { z } from 'zod';
import {
  DialogueSyncPollResultSchema,
  DialogueSyncCompletionSchema,
  type DialogueSyncJob,
} from '@wai-bridge/shared';
import { extensionBuild } from '../build-info.js';

type Port = { postMessage(value: unknown): void };
export class DialogueSyncBridge {
  private port: Port | undefined;
  private polling = false;
  private processing = false;
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: () => void; timer: ReturnType<typeof setTimeout> }
  >();
  constructor(
    private readonly instanceId: () => Promise<string>,
    private readonly tabs: Pick<typeof chrome.tabs, 'query' | 'sendMessage' | 'update'>,
    private readonly windows: Pick<typeof chrome.windows, 'update'>,
  ) {}
  get busy(): boolean {
    return this.processing;
  }
  connect(port: Port): void {
    this.port = port;
  }
  disconnect(): void {
    this.port = undefined;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject();
    }
    this.pending.clear();
  }
  receive(raw: { id: string; type: string; result?: unknown }): boolean {
    if (!['SYNC_POLL_RESULT', 'SYNC_COMPLETE_RESULT', 'ERROR'].includes(raw.type)) return false;
    const item = this.pending.get(raw.id);
    if (!item) return false;
    this.pending.delete(raw.id);
    clearTimeout(item.timer);
    if (raw.type === 'ERROR') item.reject();
    else item.resolve(raw.result);
    return true;
  }
  async poll(): Promise<void> {
    if (!this.port || this.polling) return;
    this.polling = true;
    try {
      const extensionInstanceId = await this.instanceId();
      const pending = DialogueSyncPollResultSchema.parse(
        await this.rpc('SYNC_POLL', { extensionInstanceId, ready: false }),
      );
      if (!pending.pending) return;
      this.processing = true;
      const tabs = (await this.tabs.query({ url: 'https://web.whatsapp.com/*' })).filter(
        (t) => t.id !== undefined,
      );
      if (tabs.length !== 1) return;
      const tab = tabs[0]!;
      const contextSchema = z.object({
        ok: z.literal(true),
        monitoring: z.literal(true),
        build: z.literal(extensionBuild),
        accountId: z.uuid(),
        ready: z.boolean().default(true),
      });
      const context = contextSchema.safeParse(
        await this.bounded(this.tabs.sendMessage(tab.id!, { kind: 'GET_SYNC_CONTEXT' }), 1500),
      );
      if (!context.success) return;
      await this.tabs.update(tab.id!, { active: true });
      if (tab.windowId !== undefined) await this.windows.update(tab.windowId, { focused: true });
      const visibilityDeadline = Date.now() + 1500;
      let ready = context.data.ready;
      while (!ready && Date.now() < visibilityDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 80));
        const probe = contextSchema.safeParse(
          await this.bounded(this.tabs.sendMessage(tab.id!, { kind: 'GET_SYNC_CONTEXT' }), 1000),
        );
        if (!probe.success || probe.data.accountId !== context.data.accountId) return;
        ready = probe.data.ready;
      }
      if (!ready) return;
      const claim = DialogueSyncPollResultSchema.parse(
        await this.rpc('SYNC_POLL', {
          extensionInstanceId,
          ready: true,
          accountId: context.data.accountId,
        }),
      );
      if (!claim.job) return;
      const job = claim.job;
      let result: unknown;
      try {
        result = await this.execute(tab.id!, job, extensionInstanceId);
      } catch {
        result = { code: 'CONTENT_UNREACHABLE', observations: [], truncated: false };
      }
      const completion = DialogueSyncCompletionSchema.safeParse({
        ...(result as object),
        extensionInstanceId,
        requestId: job.id,
        leaseToken: job.leaseToken,
      });
      const input = completion.success
        ? completion.data
        : {
            extensionInstanceId,
            requestId: job.id,
            leaseToken: job.leaseToken,
            code: 'INVALID_RESULT',
            observations: [],
            truncated: false,
          };
      // Retrying the same completion is safe: API commits job and observations atomically.
      try {
        await this.rpc('SYNC_COMPLETE', input);
      } catch {
        await this.rpc('SYNC_COMPLETE', input);
      }
    } catch {
      console.warn('WAI_SYNC_TRANSPORT_UNAVAILABLE');
    } finally {
      this.processing = false;
      this.polling = false;
    }
  }
  private async execute(
    tabId: number,
    job: DialogueSyncJob,
    extensionInstanceId: string,
  ): Promise<unknown> {
    if (!job.batch)
      return this.bounded(this.tabs.sendMessage(tabId, { kind: 'SYNC_DIALOGUE', job }), 16000);
    const controller = new AbortController();
    const watch = (async () => {
      while (!controller.signal.aborted) {
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            controller.signal.removeEventListener('abort', done);
            resolve();
          };
          const timer = setTimeout(done, 350);
          controller.signal.addEventListener('abort', done, { once: true });
        });
        if (controller.signal.aborted) return;
        try {
          const state = DialogueSyncPollResultSchema.parse(
            await this.rpc('SYNC_POLL', {
              extensionInstanceId,
              ready: false,
              accountId: job.accountId,
              activeRequestId: job.id,
              leaseToken: job.leaseToken,
            }),
          );
          if (!state.cancelRequestId) continue;
        } catch {
          if (controller.signal.aborted) return;
        }
        await this.bounded(
          this.tabs.sendMessage(tabId, { kind: 'SYNC_CANCEL', requestId: job.id }),
          1500,
        ).catch(() => undefined);
        return;
      }
    })();
    try {
      return await this.bounded(
        this.tabs.sendMessage(tabId, { kind: 'SYNC_DIALOGUE', job }),
        16000,
      );
    } finally {
      controller.abort();
      await watch;
    }
  }
  private bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('TIMEOUT')), ms);
      promise
        .then(resolve, reject)
        .finally(() => clearTimeout(timer))
        .catch(() => undefined);
    });
  }
  private rpc(type: 'SYNC_POLL' | 'SYNC_COMPLETE', input: unknown): Promise<unknown> {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('SYNC_TIMEOUT'));
      }, 6000);
      this.pending.set(id, {
        resolve,
        reject: () => reject(new Error('SYNC_API_UNAVAILABLE')),
        timer,
      });
      try {
        if (!this.port) throw new Error('DISCONNECTED');
        this.port.postMessage({ version: 1, id, type, input });
      } catch {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error('SYNC_DISCONNECTED'));
      }
    });
  }
}
