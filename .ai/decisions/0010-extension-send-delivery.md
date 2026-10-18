# ADR 0010 — Native delivery of explicitly authorized sends to the open conversation

- Date: 2026-10-18
- Status: Accepted for experimental implementation; real operation requires opt-in

The user requests MCP → Local API → native host → extension execution, rather than
external browser automation. The existing executor/dispatcher is simulation-only.

Use existing wa_outbox/history/audit/interface lease with a distinct kind
`extension-send`; legacy dispatcher must never claim/recover these commands.
A new read/write API surface validates a persisted conversation reference, explicit
user authorization, mode (SUPERVISED default), idempotency and extension/context
leases. PHONE/GROUP_LOCAL remain PARTIAL; no promotion to KNOWN or weakening of
legacy recipient resolution. Execution requires exact agreement with the current
user-confirmed account/reference in the visible open chat. UNKNOWN is rejected.
No navigation, label matching, session API or private WhatsApp protocol.

The native host forwards versioned validated poll/progress messages between API
and service worker. The worker chooses exactly one active WhatsApp tab with an
opted-in, confirmed content-script context and relays commands/acknowledgements.
The page awaits durable progress acknowledgement before any send click, waits
five seconds with a visible cancel control in AUTO, and rechecks context/text.
SUPERVISED composes and waits for manual send. A new outbound bubble with exact
text and a visible sent/delivered/read status is required for SENT. Pending/timeout,
crash or disconnect is UNKNOWN; never automatically requeue a claimed command.
Cancellation before SENDING is persisted; after SENDING cannot undo the effect.

Local popup opt-in, per-request literal authorization and MCP-specific opt-in are
independent gates, default off. Revoking the page gate cancels pre-click work.
The extension never gets the API token. A lost progress reply prevents the click.
A lost result reply is retried idempotently; it never causes another click.
No migration or automatic replay of legacy/previous user requests. Tests are
synthetic only. Actual WhatsApp DOM compatibility and user selection errors remain
limitations, with ambiguous contexts failing closed.
