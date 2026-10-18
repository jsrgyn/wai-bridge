import { extensionBuild } from '../build-info.js';
import { z } from 'zod';
import {
  ConversationIdentitySchema,
  ExtensionSendCommandSchema,
  ExtensionSendPollResultSchema,
  ExtensionSendProgressResultSchema,
  ExtensionSendProgressSchema,
  type ConversationIdentity,
  type ExtensionSendCommand,
  type SendBridgeReasonSchema,
} from '@wai-bridge/shared';

const ContextSchema = z.object({
  ok: z.literal(true),
  build: z.string().max(64).optional(),
  identity: ConversationIdentitySchema.optional(),
  ready: z.boolean().default(true),
  conversationLabel: z.string().max(256).nullable().optional(),
});
type Context = z.infer<typeof ContextSchema>;
type Port = { postMessage(value: unknown): void };
type Active = { tabId: number; command: ExtensionSendCommand; identity: ConversationIdentity };
const terminal = new Set(['SENT', 'FAILED', 'CANCELLED', 'UNKNOWN']);
function bounded<T>(operation: Promise<T>, ms = 1500): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CONTENT_UNREACHABLE')), ms);
    operation
      .then(resolve, reject)
      .finally(() => clearTimeout(timer))
      .catch(() => undefined);
  });
}
export class ExtensionSendBridge {
  private port: Port | undefined;
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: () => void; timer: ReturnType<typeof setTimeout> }
  >();
  private active: Active | undefined;
  private readonly completed = new Map<string, Active>();
  private polling = false;
  constructor(
    private readonly instanceId: () => Promise<string>,
    private readonly tabs: Pick<typeof chrome.tabs, 'query' | 'sendMessage'> &
      Partial<Pick<typeof chrome.tabs, 'update'>>,
    private readonly storage: Pick<typeof chrome.storage.local, 'get'>,
    private readonly windows?: Pick<typeof chrome.windows, 'update'>,
  ) {}
  connect(port: Port): void {
    this.port = port;
  }
  disconnect(): void {
    this.port = undefined;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject();
    }
    this.pending.clear();
    // Retain a claimed job for authoritative recovery; never deliver it a second time.
  }
  receive(raw: { id: string; type: string; result?: unknown }): boolean {
    if (!['SEND_POLL_RESULT', 'SEND_PROGRESS_RESULT', 'ERROR'].includes(raw.type)) return false;
    const item = this.pending.get(raw.id);
    if (!item) return false;
    this.pending.delete(raw.id);
    clearTimeout(item.timer);
    if (raw.type === 'ERROR') item.reject();
    else item.resolve(raw.result);
    return true;
  }
  async progress(raw: unknown, tabId: number) {
    const input = ExtensionSendProgressSchema.parse(raw);
    const active =
      this.active?.command.id === input.commandId
        ? this.active
        : this.completed.get(input.commandId);
    if (!active || active.tabId !== tabId) throw new Error('SEND_NOT_ACTIVE');
    const result = ExtensionSendProgressResultSchema.parse(await this.rpc('SEND_PROGRESS', input));
    if (terminal.has(result.status)) this.complete(active);
    return result;
  }
  private complete(active: Active): void {
    this.completed.set(active.command.id, active);
    if (this.completed.size > 32) this.completed.delete(this.completed.keys().next().value!);
    if (this.active === active) this.active = undefined;
  }
  private async report(reason: z.infer<typeof SendBridgeReasonSchema>): Promise<void> {
    await this.rpc('SEND_POLL', {
      extensionInstanceId: await this.instanceId(),
      allowClaim: false,
      ready: false,
      reason,
      protocolVersion: 2,
      clientBuild: extensionBuild,
    });
  }
  async poll(): Promise<void> {
    if (!this.port || this.polling) return;
    this.polling = true;
    try {
      const enabled =
        (await this.storage.get('waiExtensionSendsEnabled')).waiExtensionSendsEnabled === true;
      const instance = await this.instanceId();
      const active = this.active;
      if (active) {
        if (!enabled)
          void bounded(
            this.tabs.sendMessage(active.tabId, { kind: 'SEND_CONTEXT', enabled: false }),
          ).catch(() => undefined);
        const result = ExtensionSendPollResultSchema.parse(
          await this.rpc('SEND_POLL', {
            extensionInstanceId: instance,
            allowClaim: enabled,
            ready: false,
            reason: 'EXECUTING',
            protocolVersion: 2,
            clientBuild: extensionBuild,
            identity: active.identity,
            activeCommand: {
              id: active.command.id,
              contextId: active.command.contextId,
              leaseToken: active.command.leaseToken,
            },
          }),
        );
        if (result.activeStatus && terminal.has(result.activeStatus)) {
          await bounded(
            this.tabs.sendMessage(active.tabId, {
              kind: 'SEND_CANCEL',
              commandId: active.command.id,
            }),
          ).catch(() => undefined);
          this.complete(active);
        }
        return;
      }
      const tabs = (await bounded(this.tabs.query({ url: 'https://web.whatsapp.com/*' }))).filter(
        (tab) => tab.id !== undefined && tab.url?.startsWith('https://web.whatsapp.com/'),
      );
      if (!tabs.length) {
        await this.report('NO_WHATSAPP_TAB');
        return;
      }
      if (tabs.length > 8) {
        await this.report('AMBIGUOUS_TABS');
        return;
      }
      const contexts = await Promise.allSettled(
        tabs.map(async (tab) => ({
          tab,
          context: ContextSchema.parse(
            await bounded(this.tabs.sendMessage(tab.id!, { kind: 'SEND_CONTEXT', enabled })),
          ),
        })),
      );
      const candidates: {
        tab: (typeof tabs)[number];
        context: Context & { identity: ConversationIdentity };
      }[] = [];
      let reachable = false;
      let outdated = false;
      for (const entry of contexts) {
        if (entry.status !== 'fulfilled') continue;
        reachable = true;
        const { tab, context } = entry.value;
        if (
          context.build !== extensionBuild &&
          !(extensionBuild === 'development' && context.build === undefined)
        ) {
          outdated = true;
          continue;
        }
        if (!context.identity) continue;
        const result = ExtensionSendPollResultSchema.parse(
          await this.rpc('SEND_POLL', {
            extensionInstanceId: instance,
            allowClaim: enabled,
            ready: false,
            visible: context.ready,
            reason: !enabled ? 'SEND_DISABLED' : context.ready ? 'READY' : 'TAB_HIDDEN',
            protocolVersion: 2,
            clientBuild: extensionBuild,
            identity: context.identity,
            ...(context.conversationLabel !== undefined
              ? { conversationLabel: context.conversationLabel }
              : {}),
          }),
        );
        // Preflight is read-only for delivery: no command may be claimed here.
        if (result.pending)
          candidates.push({ tab, context: { ...context, identity: context.identity } });
      }
      if (!candidates.length) {
        if (outdated) {
          await this.report('CONTENT_OUTDATED');
          return;
        }
        if (!contexts.some((entry) => entry.status === 'fulfilled' && entry.value.context.identity))
          await this.report(reachable ? 'NO_MONITORED_CONTEXT' : 'CONTENT_UNREACHABLE');
        return;
      }
      if (candidates.length !== 1) {
        await this.report('AMBIGUOUS_TABS');
        return;
      }
      if (!enabled) return;
      const { tab, context } = candidates[0]!;
      if (!context.ready) {
        // Only an explicit pending intent + opt-in can activate an existing target tab.
        if (this.tabs.update) await bounded(this.tabs.update(tab.id!, { active: true }));
        if (this.windows && tab.windowId !== undefined)
          await bounded(this.windows.update(tab.windowId, { focused: true }));
        return; // wait for a fresh visible context; never claim/send in the background
      }
      const fresh = ContextSchema.parse(
        await bounded(this.tabs.sendMessage(tab.id!, { kind: 'SEND_CONTEXT', enabled })),
      );
      if (
        !fresh.ready ||
        fresh.identity?.accountId !== context.identity.accountId ||
        (extensionBuild !== 'development' && fresh.build !== extensionBuild)
      )
        return;
      const result = ExtensionSendPollResultSchema.parse(
        await this.rpc('SEND_POLL', {
          extensionInstanceId: instance,
          allowClaim: true,
          ready: true,
          reason: 'READY',
          protocolVersion: 2,
          clientBuild: extensionBuild,
          identity: fresh.identity,
          ...(fresh.conversationLabel !== undefined
            ? { conversationLabel: fresh.conversationLabel }
            : {}),
        }),
      );
      if (!result.command) return;
      const command = ExtensionSendCommandSchema.parse(result.command);
      this.active = { tabId: tab.id!, command, identity: fresh.identity };
      // Content replies on acceptance; progress/cancellation use the durable separate channel.
      const acknowledgement = await bounded(
        this.tabs.sendMessage(tab.id!, { kind: 'SEND_EXECUTE', command }),
      );
      if (acknowledgement?.ok === false) {
        await this.progress(
          {
            extensionInstanceId: instance,
            commandId: command.id,
            contextId: command.contextId,
            leaseToken: command.leaseToken,
            step: 'FAILED',
            code: 'EXECUTOR_REJECTED',
          },
          tab.id!,
        );
      }
    } catch {
      // A failed/lost acceptance ACK must never cause a second execution attempt.
      // A stalled UI request times out; active jobs remain under backend lease recovery.
      if (!this.active && this.port)
        await this.report('CONTENT_UNREACHABLE').catch(() => undefined);
    } finally {
      this.polling = false;
    }
  }
  private rpc(type: 'SEND_POLL' | 'SEND_PROGRESS', input: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.port) {
        reject(new Error('PROGRESS_UNAVAILABLE'));
        return;
      }
      const id = crypto.randomUUID();
      const fail = () => reject(new Error('PROGRESS_UNAVAILABLE'));
      const timer = setTimeout(() => {
        this.pending.delete(id);
        fail();
      }, 6000);
      this.pending.set(id, { resolve, reject: fail, timer });
      try {
        this.port.postMessage({ version: 1, id, type, input });
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        fail();
      }
    });
  }
}
