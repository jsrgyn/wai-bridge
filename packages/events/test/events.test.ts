import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../database/src/index.js';
import {
  EventDeliveryService,
  EventDispatcher,
  PermanentDeliveryError,
  EventService,
  RetryService,
  WebSocketNotifier,
  type Clock,
  type EventEnvelope,
  type Notifier,
} from '../src/index.js';
const dirs: string[] = [];
class FakeClock implements Clock {
  private current = Date.parse('2026-10-17T12:00:00.000Z');
  private sleepers: {
    at: number;
    resolve: () => void;
    reject: () => void;
    signal?: AbortSignal;
  }[] = [];
  now(): string {
    return new Date(this.current).toISOString();
  }
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const sleeper = { at: this.current + ms, resolve, reject, ...(signal ? { signal } : {}) };
      this.sleepers.push(sleeper);
      signal?.addEventListener(
        'abort',
        () => {
          this.sleepers = this.sleepers.filter((item) => item !== sleeper);
          reject(new Error('SLEEP_ABORTED'));
        },
        { once: true },
      );
    });
  }
  advance(ms: number): void {
    this.current += ms;
    const ready = this.sleepers.filter((s) => s.at <= this.current);
    this.sleepers = this.sleepers.filter((s) => s.at > this.current);
    for (const s of ready) s.resolve();
  }
}
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'wai-events-'));
  dirs.push(dir);
  const dbPath = join(dir, 'events.sqlite');
  const db = openDatabase(dbPath);
  const clock = new FakeClock();
  const service = new EventService(db);
  return { dir, db, dbPath, clock, service };
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function createEvent(service: EventService, key = 'event-idempotency-key-0001') {
  return service.publish({
    id: randomUUID(),
    type: 'message.received',
    aggregateType: 'message',
    aggregateId: randomUUID(),
    occurredAt: '2026-10-17T12:00:00.000Z',
    payloadVersion: 1,
    payload: { messageId: 'synthetic-message' },
    idempotencyScope: 'test',
    idempotencyKey: key,
  });
}
describe('event engine', () => {
  it('persists an event and delivery before dispatch', () => {
    const { db, service } = setup();
    const result = createEvent(service);
    expect(result.duplicate).toBe(false);
    expect(db.prepare('SELECT count(*) n FROM wa_events').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT status FROM wa_event_delivery').get()).toEqual({ status: 'PENDING' });
  });
  it('returns the existing event for duplicate idempotency key and rejects changed payload', () => {
    const { db, service } = setup();
    const first = createEvent(service);
    const duplicate = service.publish({ ...first.event, id: randomUUID() });
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.event.id).toBe(first.event.id);
    expect(db.prepare('SELECT count(*) n FROM wa_events').get()).toEqual({ n: 1 });
    expect(() =>
      service.publish({ ...first.event, id: randomUUID(), payload: { different: true } }),
    ).toThrow('IDEMPOTENCY_CONFLICT');
  });
  it('delivers a normal event through WebSocket notifier', async () => {
    const { db, service, clock } = setup();
    const published = createEvent(service);
    const notifier = new WebSocketNotifier();
    let payload = '';
    notifier.addClient({
      id: 'client-1',
      isOpen: () => true,
      send: async (data) => {
        payload = data;
      },
    });
    const dispatcher = new EventDispatcher(db, notifier, clock);
    expect(await dispatcher.dispatchOne('worker-1')).toBe('DELIVERED');
    expect(JSON.parse(payload).id).toBe(published.event.id);
    expect(db.prepare('SELECT status,attempt FROM wa_event_delivery').get()).toEqual({
      status: 'DELIVERED',
      attempt: 1,
    });
  });
  it('keeps event durable after lost notification and retries after reconnect', async () => {
    const { db, service, clock } = setup();
    createEvent(service);
    const notifier = new WebSocketNotifier();
    const dispatcher = new EventDispatcher(db, notifier, clock);
    expect(await dispatcher.dispatchOne('worker')).toBe('RETRY');
    expect(db.prepare('SELECT count(*) n FROM wa_events').get()).toEqual({ n: 1 });
    clock.advance(1000);
    notifier.addClient({ id: 'reconnected', isOpen: () => true, send: async () => {} });
    expect(await dispatcher.dispatchOne('worker')).toBe('DELIVERED');
  });
  it('records a disconnected client attempt', async () => {
    const { db, service, clock } = setup();
    createEvent(service);
    const result = await new EventDispatcher(db, new WebSocketNotifier(), clock).dispatchOne(
      'worker',
    );
    expect(result).toBe('RETRY');
    expect(db.prepare('SELECT attempt,last_error_code FROM wa_event_delivery').get()).toMatchObject(
      { attempt: 1, last_error_code: 'CLIENT_DISCONNECTED' },
    );
    expect(db.prepare('SELECT outcome FROM wa_event_delivery_attempt').get()).toEqual({
      outcome: 'RETRY',
    });
  });
  it('recovers an expired lease and prevents two workers owning one delivery', () => {
    const { db, service, clock } = setup();
    createEvent(service);
    const deliveries = new EventDeliveryService(db);
    const lease = deliveries.claim('worker-1', clock.now(), 1000);
    expect(lease).toBeDefined();
    expect(deliveries.claim('worker-2', clock.now(), 1000)).toBeUndefined();
    clock.advance(1001);
    expect(deliveries.recoverExpired(clock.now())).toBe(1);
    const recovered = deliveries.claim('worker-2', clock.now(), 1000);
    expect(recovered?.attempt).toBe(2);
    expect(() => deliveries.delivered(lease!, clock.now())).toThrow('no longer owned');
  });
  it('turns notifier timeout into a retry using controlled clock', async () => {
    const { db, service, clock } = setup();
    createEvent(service);
    const never: Notifier = { notify: () => new Promise(() => {}) };
    const dispatch = new EventDispatcher(db, never, clock, { notifyTimeoutMs: 50 });
    const pending = dispatch.dispatchOne('worker');
    await Promise.resolve();
    clock.advance(50);
    expect(await pending).toBe('RETRY');
    expect(db.prepare('SELECT last_error_code FROM wa_event_delivery').get()).toEqual({
      last_error_code: 'NOTIFIER_TIMEOUT',
    });
  });
  it('uses exponential backoff and moves permanent failures to logical DLQ', async () => {
    const { db, service, clock } = setup();
    createEvent(service);
    const fail: Notifier = {
      notify: async () => {
        throw new Error('transport error');
      },
    };
    const dispatch = new EventDispatcher(db, fail, clock);
    const retry = new RetryService();
    expect(retry.nextAttemptAt(clock.now(), 2)).toBe(
      new Date(Date.parse(clock.now()) + 2000).toISOString(),
    );
    for (let attempt = 1; attempt <= 8; attempt++) {
      expect(await dispatch.dispatchOne(`worker-${attempt}`)).toBe(
        attempt === 8 ? 'DEAD_LETTER' : 'RETRY',
      );
      clock.advance(Math.min(1000 * 2 ** (attempt - 1), 300000));
    }
    expect(dispatch.getDeadLetters()).toHaveLength(1);
    expect(
      db.prepare('SELECT status,attempt,dead_lettered_at FROM wa_event_delivery').get(),
    ).toMatchObject({ status: 'FAILED', attempt: 8 });
    expect(db.prepare('SELECT count(*) n FROM wa_event_delivery_attempt').get()).toEqual({ n: 8 });
  });
  it('sends permanent failures directly to the logical dead letter queue', async () => {
    const { db, service, clock } = setup();
    createEvent(service);
    const permanent: Notifier = {
      notify: async () => {
        throw new PermanentDeliveryError('INVALID_EVENT_PAYLOAD');
      },
    };
    const dispatcher = new EventDispatcher(db, permanent, clock);
    expect(await dispatcher.dispatchOne('worker')).toBe('DEAD_LETTER');
    expect(
      db.prepare('SELECT attempt,last_error_code,dead_lettered_at FROM wa_event_delivery').get(),
    ).toMatchObject({ attempt: 1, last_error_code: 'INVALID_EVENT_PAYLOAD' });
    expect(db.prepare('SELECT outcome FROM wa_event_delivery_attempt').get()).toEqual({
      outcome: 'DEAD_LETTER',
    });
  });

  it('recovers persisted events after database restart', () => {
    const { db, dbPath, service } = setup();
    const original = createEvent(service).event.id;
    db.close();
    const restarted = openDatabase(dbPath);
    const row = restarted.prepare('SELECT id FROM wa_events').get() as { id: string };
    expect(row.id).toBe(original);
    expect(restarted.prepare('SELECT status FROM wa_event_delivery').get()).toEqual({
      status: 'PENDING',
    });
  });
  it('keeps disconnected WebSocket clients out of notifications', async () => {
    const notifier = new WebSocketNotifier();
    let sent = 0;
    notifier.addClient({
      id: 'closed',
      isOpen: () => false,
      send: async () => {
        sent++;
      },
    });
    const fake: EventEnvelope = {
      id: randomUUID(),
      type: 'message.detected',
      aggregateType: 'message',
      aggregateId: 'm1',
      occurredAt: '2026-10-17T12:00:00.000Z',
      payloadVersion: 1,
      payload: {},
    };
    expect(await notifier.notify(fake)).toBe(false);
    expect(sent).toBe(0);
  });
});
