import { QueueLimitsSchema, CaptureQueueDiagnosticsSchema } from '@wai-bridge/shared';
import { CaptureObservationSchema, type CaptureObservation } from '../contracts.js';

const QUEUE_KEY = 'waiBridgeCaptureQueue';
const METRICS_KEY = 'waiBridgeCaptureMetrics';
const QUARANTINE_KEY = 'waiBridgeCaptureQuarantine';

export interface QueueStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface NativePort {
  postMessage(message: unknown): void;
}

/** The queue is removed only after the API returns a persisted event ID. */
export class EventPublisher {
  private operation: Promise<unknown> = Promise.resolve();
  private port: NativePort | undefined;
  private extensionInstanceId: string | undefined;
  private inFlight: string | undefined;
  private ackTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly limits;
  private metrics = {
    overflowCount: 0,
    storageErrorCount: 0,
    retryCount: 0,
    lastAckAt: null as string | null,
  };
  constructor(
    private readonly storage: QueueStorage,
    limits: unknown = {},
  ) {
    this.limits = QueueLimitsSchema.parse(limits);
  }
  private bytes(value: unknown) {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  }
  private async loadMetrics() {
    const raw = (await this.readStore(METRICS_KEY))[METRICS_KEY];
    if (raw && typeof raw === 'object') {
      const m = raw as Record<string, unknown>;
      for (const key of ['overflowCount', 'storageErrorCount', 'retryCount'] as const)
        if (typeof m[key] === 'number' && Number.isSafeInteger(m[key]) && m[key] >= 0)
          this.metrics[key] = Math.max(this.metrics[key], m[key]);
      if (typeof m.lastAckAt === 'string' && Number.isFinite(Date.parse(m.lastAckAt)))
        this.metrics.lastAckAt = m.lastAckAt;
    }
  }
  private async readStore(key: string) {
    try {
      return await this.storage.get(key);
    } catch {
      this.metrics.storageErrorCount++;
      throw Error('CAPTURE_STORAGE_UNAVAILABLE');
    }
  }
  private async save(values: Record<string, unknown>) {
    try {
      await this.storage.set({ ...values, [METRICS_KEY]: this.metrics });
    } catch (error) {
      this.metrics.storageErrorCount++;
      throw error;
    }
  }
  diagnostics() {
    return this.serialize(async () => {
      await this.loadMetrics();
      const queue = await this.readQueue();
      const quarantine = (await this.readStore(QUARANTINE_KEY))[QUARANTINE_KEY];
      const quarantined = Array.isArray(quarantine) ? quarantine.length : 0;
      return CaptureQueueDiagnosticsSchema.parse({
        ...this.metrics,
        pending: queue.length,
        bytes: this.bytes(queue),
        quarantined,
        oldestAt: queue[0]?.observedAt ?? null,
        connected: Boolean(this.port),
        possibleGaps:
          quarantined > 0 || this.metrics.overflowCount > 0 || this.metrics.storageErrorCount > 0,
        limits: this.limits,
        complete: false,
      });
    });
  }

  enqueue(value: unknown): Promise<void> {
    return this.serialize(async () => {
      const observation = CaptureObservationSchema.parse(value);
      const queue = await this.readQueue();
      if (queue.some((item) => item.observationId === observation.observationId)) return;
      if (
        queue.length >= this.limits.maxItems ||
        this.bytes([...queue, observation]) > this.limits.maxBytes
      ) {
        await this.loadMetrics();
        this.metrics.overflowCount++;
        await this.save({});
        throw new Error('CAPTURE_QUEUE_FULL');
      }
      await this.save({ [QUEUE_KEY]: [...queue, observation] });
      await this.flush();
    });
  }

  connect(port: NativePort, extensionInstanceId: string): Promise<void> {
    return this.serialize(async () => {
      if (this.ackTimer) clearTimeout(this.ackTimer);
      this.ackTimer = undefined;
      this.port = port;
      this.extensionInstanceId = extensionInstanceId;
      this.inFlight = undefined;
      await this.flush();
    });
  }

  disconnect(): void {
    this.port = undefined;
    this.inFlight = undefined;
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = undefined;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  acknowledge(observationId: string, eventId: string): Promise<void> {
    return this.serialize(async () => {
      if (this.inFlight !== observationId || !eventId) return;
      const queue = await this.readQueue();
      await this.loadMetrics();
      this.metrics.lastAckAt = new Date().toISOString();
      await this.save({
        [QUEUE_KEY]: queue.filter((item) => item.observationId !== observationId),
      });
      if (this.ackTimer) clearTimeout(this.ackTimer);
      this.ackTimer = undefined;
      this.inFlight = undefined;
      await this.flush();
    });
  }

  retryLater(requestId: string): void {
    if (this.inFlight !== requestId) return;
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = undefined;
    this.inFlight = undefined;
    this.metrics.retryCount++;
    void this.serialize(() => this.save({}));
    if (!this.retryTimer)
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        void this.serialize(() => this.flush());
      }, 5_000);
  }

  private async readQueue(): Promise<CaptureObservation[]> {
    const stored = await this.readStore(QUEUE_KEY);
    const raw = stored[QUEUE_KEY];
    if (raw === undefined) return [];
    const values = Array.isArray(raw) ? raw : [raw];
    const queue: CaptureObservation[] = [],
      invalid: unknown[] = [];
    for (const value of values) {
      const parsed = CaptureObservationSchema.safeParse(value);
      if (parsed.success) queue.push(parsed.data);
      else invalid.push(value);
    }
    if (invalid.length) {
      const prior = (await this.readStore(QUARANTINE_KEY))[QUARANTINE_KEY];
      const quarantine = [...(Array.isArray(prior) ? prior : []), ...invalid];
      if (this.bytes(quarantine) > 524288) throw Error('CAPTURE_QUARANTINE_FULL');
      await this.save({ [QUEUE_KEY]: queue, [QUARANTINE_KEY]: quarantine });
    }
    return queue;
  }

  private async flush(): Promise<void> {
    if (!this.port || !this.extensionInstanceId || this.inFlight || this.retryTimer) return;
    const next = (await this.readQueue())[0];
    if (!next) return;
    this.inFlight = next.observationId;
    try {
      this.port.postMessage({
        version: 1,
        id: next.observationId,
        type: 'CAPTURE_OBSERVATION',
        extensionInstanceId: this.extensionInstanceId,
        observation: next,
      });
      if (this.ackTimer) clearTimeout(this.ackTimer);
      this.ackTimer = setTimeout(() => {
        this.ackTimer = undefined;
        void this.serialize(async () => {
          if (this.inFlight === next.observationId) {
            this.inFlight = undefined;
            this.metrics.retryCount++;
            await this.save({}).catch(() => undefined);
            await this.flush();
          }
        });
      }, 5000);
    } catch {
      this.inFlight = undefined;
      this.port = undefined;
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.catch(() => undefined);
    return result;
  }
}
