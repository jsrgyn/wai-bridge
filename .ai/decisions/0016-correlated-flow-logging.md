# ADR 0016 — Correlated, bounded operational flow logs

Date: 2026-10-18. Status: Accepted (explicit user request).

Add a strict shared log contract and a separate SQLite diagnostic log table, owned
only by the Local API. Logs are operational telemetry, not the durable audit/outbox
or an authoritative WhatsApp server receipt. Components: MCP, API, NATIVE_HOST,
EXTENSION_BACKGROUND, EXTENSION_CONTENT, WHATSAPP_UI, SQLITE. WHATSAPP_UI means
observed accessible DOM interactions only, never interception of WhatsApp internals.

A send gets a trace UUID at MCP entry, carried in x-wai-trace-id and persisted as
outbox flow_trace_id separately from the idempotency hash. Commands carry the same
trace, with command UUID as resourceId. Capture uses observation UUID as traceId
and resourceId. HTTP request IDs and native frame IDs remain distinct. Replays
retain the original command trace; attempts remain visible without duplicate sends.

Allow only enumerated phases/outcomes/error codes, UUID identifiers, timestamps,
bounded durations/attempts and compiler build IDs. No arbitrary details/messages,
body, headers, paths, stack traces, names, phones, media or credentials. Validation
failure cannot silently admit extra fields. Logs are not trusted instructions.

MCP/native also write safe structured records to stderr (never stdout). They submit
small batches to the authenticated Local API. Extension logs use a bounded buffered
Native Messaging channel, with short batching, ACK/retry and dedup by log UUID.
Logging is best effort and must never gate SENDING, retry an external effect, extend
a lease, or change message read state. Failure is observable locally without logging
its own transport recursively. Idle polls are sampled as state changes, not 1Hz noise.

Retain at most 20,000 diagnostic rows and seven days by server receive time, with
indexed trace/resource/component queries. This retention never deletes business
messages, events, outbox history or audit rows. A schema migration adds the table
and outbox trace metadata. API GET /api/diagnostics/logs and MCP
whatsapp_get_flow_logs provide filtered bounded pages, last-recorded telemetry and
separate authoritative outbox status. Receipt sequence does not prove causal order;
logs can arrive in batches/out of order or be absent after failures. Coverage is
explicitly BEST_EFFORT_INSTRUMENTATION, with no retrospective reconstruction claims.

Central SQLite telemetry was preferred to scattered free-text logs or extra
services. No new external service/dependency or direct extension/MCP DB access.
