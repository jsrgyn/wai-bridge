# ADR 0004: Incremental UI observations and durable handoff

- Date: 2026-10-17
- Status: Accepted for the experimental observer

## Context

The Chrome extension can see only the rendered WhatsApp Web interface. A visual unread indicator gives no reliable message body or stable external message ID. The macOS host must intermediate communication, and SQLite remains owned by the Local API. Browser and host disconnects may occur between observation and event persistence.

## Decision

Observe added message nodes in the open pane and new conversation rows or unread indicator increases. Do not scan existing descendants on activation, navigate automatically, or infer message content from an unread counter. Represent each observation with a generated UUID, partial visible metadata, and `DETECTED`, `CAPTURED`, `PENDING`, or `FAILED` state. `CaptureStateManager` deduplicates DOM nodes during a page session. The extension stores a bounded queue in local extension storage; its publisher retries the same observation ID over Native Messaging. The host checks extension origin and HELLO session and forwards through the authenticated Local API. The API inserts an observation staging record and event in one SQLite transaction. A repeated ID is accepted only with the same extension instance and payload. Event notifications carry a reference to the observation, not message text. AI read state is untouched.

## Alternatives considered

- Direct SQLite access from the extension: violates process ownership and browser constraints.
- Treat unread counts as message content: the count contains no message body.
- Use visible names as stable IDs: names can duplicate or change.
- Store the full observation in the event payload: exposes text to event consumers that only need notification metadata.
- Automatic navigation to read unopened conversations: can affect the WhatsApp read indicator and needs separate authorization.

## Consequences

Real WhatsApp DOM compatibility and complete capture are unverified. DOM replacement may present old content as a new node. Distinct nodes with the same visible text cannot safely be collapsed. Queue saturation, storage failure, and a crash before queuing can lose observations; errors are surfaced and completeness is never claimed. An observation is retrievable only through an authenticated API route. Later identity reconciliation must be designed separately before writing canonical `wa_messages` rows.
