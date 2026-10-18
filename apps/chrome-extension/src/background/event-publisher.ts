import { CaptureObservationSchema, type CaptureObservation } from '../contracts.js';

const QUEUE_KEY = 'waiBridgeCaptureQueue';
const MAX_QUEUED = 100;

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
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly storage: QueueStorage) {}

  enqueue(value: unknown): Promise<void> {
    return this.serialize(async () => {
      const observation = CaptureObservationSchema.parse(value);
      const queue = await this.readQueue();
      if (queue.some((item) => item.observationId === observation.observationId)) return;
      if (queue.length >= MAX_QUEUED) throw new Error('CAPTURE_QUEUE_FULL');
      await this.storage.set({ [QUEUE_KEY]: [...queue, observation] });
      await this.flush();
    });
  }

  connect(port: NativePort, extensionInstanceId: string): Promise<void> {
    return this.serialize(async () => {
      this.port = port;
      this.extensionInstanceId = extensionInstanceId;
      this.inFlight = undefined;
      await this.flush();
    });
  }

  disconnect(): void {
    this.port = undefined;
    this.inFlight = undefined;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  acknowledge(observationId: string, eventId: string): Promise<void> {
    return this.serialize(async () => {
      if (this.inFlight !== observationId || !eventId) return;
      const queue = await this.readQueue();
      await this.storage.set({ [QUEUE_KEY]: queue.filter((item) => item.observationId !== observationId) });
      this.inFlight = undefined;
      await this.flush();
    });
  }

  retryLater(requestId: string): void {
    if (this.inFlight !== requestId) return;
    this.inFlight = undefined;
    if (!this.retryTimer) this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.serialize(() => this.flush());
    }, 5_000);
  }

  private async readQueue(): Promise<CaptureObservation[]> {
    const stored = await this.storage.get(QUEUE_KEY);
    const raw = stored[QUEUE_KEY];
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((value) => {
      const parsed = CaptureObservationSchema.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    });
  }

  private async flush(): Promise<void> {
    if (!this.port || !this.extensionInstanceId || this.inFlight) return;
    const next = (await this.readQueue())[0];
    if (!next) return;
    this.inFlight = next.observationId;
    try {
      this.port.postMessage({
        version: 1, id: next.observationId, type: 'CAPTURE_OBSERVATION',
        extensionInstanceId: this.extensionInstanceId, observation: next,
      });
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
