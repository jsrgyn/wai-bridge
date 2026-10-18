import { FlowLogSchema, type FlowLog } from '@wai-bridge/shared';
import type { QueueStorage, NativePort } from './event-publisher.js';
const KEY = 'waiBridgeFlowLogQueue';
/** Telemetry has its own bounded queue; it never holds the command/capture queues. */
export class FlowLogPublisher {
  private operation: Promise<unknown> = Promise.resolve();
  private port: NativePort | undefined;
  private instance: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flight: { id: string; ids: Set<string> } | undefined;
  constructor(private readonly storage: QueueStorage) {}
  enqueue(raw: unknown): Promise<void> {
    return this.serial(async () => {
      const event = FlowLogSchema.parse(raw);
      const queue = await this.read();
      if (!queue.some((item) => item.id === event.id))
        await this.storage.set({ [KEY]: [...queue, event].slice(-200) });
      this.schedule(200);
    });
  }
  connect(port: NativePort, instance: string): void {
    this.port = port;
    this.instance = instance;
    this.schedule(200);
  }
  disconnect(): void {
    this.port = undefined;
    this.flight = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  receive(raw: { id: string; type: string; accepted?: number }): boolean {
    if (
      !this.flight ||
      raw.id !== this.flight.id ||
      !['FLOW_LOGS_RESULT', 'ERROR'].includes(raw.type)
    )
      return false;
    const flight = this.flight;
    this.flight = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (raw.type === 'FLOW_LOGS_RESULT' && raw.accepted === flight.ids.size)
      void this.serial(async () => {
        const queue = await this.read();
        await this.storage.set({ [KEY]: queue.filter((event) => !flight.ids.has(event.id)) });
        this.schedule(200);
      }).catch(() => undefined);
    else this.schedule(1000);
    return true;
  }
  private schedule(ms: number) {
    if (this.timer || !this.port || this.flight) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.serial(() => this.flush()).catch(() => undefined);
    }, ms);
  }
  private async flush() {
    if (!this.port || !this.instance || this.flight) return;
    const batch = (await this.read()).slice(0, 50);
    if (!batch.length) return;
    const id = crypto.randomUUID();
    this.flight = { id, ids: new Set(batch.map((event) => event.id)) };
    try {
      this.port.postMessage({
        version: 1,
        id,
        type: 'FLOW_LOGS',
        extensionInstanceId: this.instance,
        events: batch,
      });
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.flight = undefined;
        this.schedule(1000);
      }, 3000);
    } catch {
      this.flight = undefined;
      this.schedule(1000);
    }
  }
  private async read(): Promise<FlowLog[]> {
    const stored = (await this.storage.get(KEY))[KEY];
    return Array.isArray(stored)
      ? stored.flatMap((raw) => {
          const parsed = FlowLogSchema.safeParse(raw);
          return parsed.success ? [parsed.data] : [];
        })
      : [];
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.operation.then(run, run);
    this.operation = result.catch(() => undefined);
    return result;
  }
}
