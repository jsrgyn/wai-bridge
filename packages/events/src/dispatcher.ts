import type Database from 'better-sqlite3';
import { EventDeliveryService, type LeasedDelivery } from './delivery-service.js';
import { EventRepository } from './event-repository.js';
import { RetryService } from './retry-service.js';
import { systemClock, type Clock, type Notifier } from './contracts.js';
export class PermanentDeliveryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'PermanentDeliveryError';
  }
}
export interface DispatcherOptions {
  readonly leaseMs?: number;
  readonly notifyTimeoutMs?: number;
  readonly maxAttempts?: number;
}
export class EventDispatcher {
  private readonly deliveries: EventDeliveryService;
  private readonly events: EventRepository;
  private readonly retry: RetryService;
  constructor(
    db: Database.Database,
    private readonly notifier: Notifier,
    private readonly clock: Clock = systemClock,
    private readonly options: DispatcherOptions = {},
  ) {
    this.deliveries = new EventDeliveryService(db);
    this.events = new EventRepository(db);
    this.retry = new RetryService();
  }
  async dispatchOne(workerId: string): Promise<'IDLE' | 'DELIVERED' | 'RETRY' | 'DEAD_LETTER'> {
    const now = this.clock.now();
    this.deliveries.recoverExpired(now);
    const delivery = this.deliveries.claim(workerId, now, this.options.leaseMs ?? 30_000);
    if (!delivery) return 'IDLE';
    const event = this.events.getEvent(delivery.eventId);
    if (!event) {
      this.deliveries.retry(delivery, this.clock.now(), 'EVENT_NOT_FOUND', this.clock.now());
      return 'RETRY';
    }
    const controller = new AbortController();
    try {
      const timeout = this.clock.sleep(this.options.notifyTimeoutMs ?? 10_000).then(() => {
        controller.abort();
        throw new Error('NOTIFIER_TIMEOUT');
      });
      const accepted = await Promise.race([
        this.notifier.notify(event, controller.signal),
        timeout,
      ]);
      if (!accepted) throw new Error('NO_CONNECTED_CLIENT');
      this.deliveries.delivered(delivery, this.clock.now());
      return 'DELIVERED';
    } catch (error) {
      const permanent = error instanceof PermanentDeliveryError;
      const code = permanent
        ? error.code
        : error instanceof Error
          ? error.message === 'NOTIFIER_TIMEOUT'
            ? 'NOTIFIER_TIMEOUT'
            : error.message === 'NO_CONNECTED_CLIENT'
              ? 'CLIENT_DISCONNECTED'
              : 'NOTIFIER_FAILURE'
          : 'NOTIFIER_FAILURE';
      const deadLettered = this.deliveries.retry(
        delivery,
        this.clock.now(),
        code,
        this.retry.nextAttemptAt(this.clock.now(), delivery.attempt),
        permanent,
      );
      return deadLettered.deadLettered ? 'DEAD_LETTER' : 'RETRY';
    }
  }
  getDeadLetters(): readonly unknown[] {
    return this.deliveries.getDeadLetters();
  }
  claim(workerId: string, now = this.clock.now()): LeasedDelivery | undefined {
    return this.deliveries.claim(workerId, now, this.options.leaseMs ?? 30_000);
  }
}
