# @wai-bridge/events

Durable event ingestion and notification primitives backed by the Local API SQLite connection. `EventService` appends an event, allocates its monotonic sequence, and creates one pending broadcast delivery in the same `BEGIN IMMEDIATE` transaction. Event IDs and scoped idempotency keys are unique; reuse with different payload is rejected.

`EventDispatcher` leases work, logs each attempt, retries transient failures with capped exponential backoff, recovers expired worker leases, and moves exhausted/permanent failures to a logical dead letter queue (`FAILED` plus `dead_lettered_at`). Default lease is 30 seconds, notifier timeout 10 seconds, max attempts 8; callers can configure worker timing.

`WebSocketNotifier` is a transport adapter over connected clients, not an event store or source of truth. `notify=true` means at least one connected adapter accepted the payload; it is not an application ACK. Consumers deduplicate by event ID and recover missed events from persisted API cursor queries. No concrete WebSocket server or API route is included in this package.

All retry/lease time is supplied through `Clock`; tests use a controlled clock and fake notifier, with no WhatsApp dependency.
