# ADR 0015 — Responsive extension delivery and command supervision

Date: 2026-10-18. Status: Accepted (user requests diagnosis and responsiveness).

## Context and decision

A real outbox intent expired after five minutes without a claim. The bridge only
looked at the active tab of the last Chrome window. It held SEND_EXECUTE open for
the full manual wait, stopped polling while active and did not observe API-side
cancellation. Those are delivery/lifecycle defects, separate from DOM search.

Discover the existing WhatsApp tabs with bounded context requests. Advertise the
monitored contexts through the native host even when another tab is selected.
Preflight polls never claim; only a single matching eligible tab may receive a
command. If exactly one matched tab is hidden, an explicitly authorized pending
intent plus the existing extension send opt-in permits activating that existing
tab/window. No focus changes on idle polls, unknown account, ambiguous tabs or
monitor OFF. Claim and execution still require a freshly visible context. This
supersedes the earlier no-focus behavior for explicitly requested sends only.
No new host permissions or hidden sending are introduced.

SEND_EXECUTE acknowledges acceptance promptly, not delivery. Execution outcome
continues to use durable native progress. Polling continues while active, using
the original command/context/token to read authoritative status without claiming
another command. Terminal/cancelled backend status aborts the local job; deadlines
and failed ACKs never replay a command. Short bounded UI RPCs prevent a lost tab
response from permanently wedging polling. Preserve a claim until authoritative
terminal state/lease expiry; the API remains owner of recovery and singleton lease.

Poll every second and wake on relevant browser/visibility/opt-in events. Persist
bounded routing diagnostics (ready/reason, opt-in, protocol version) alongside the
existing sync heartbeat. whatsapp_status exposes fresh native/bridge readiness and
queue counts without contacts, phones, message content or lease tokens. Missing
content scripts, multiple tabs, hidden visibility and ongoing manual waits become
observable rather than a generic database-ok status. No new SQLite migration.

Reuse a currently visible matching profile before searching again. Reduce repeated
layout/style reads by filtering profile leaves by name/phone before visibility
checks. Identity, draft, authorization, five-second AUTO delay, SUPERVISED click,
durable SENDING, exact phone proof and UNKNOWN/no-retry remain mandatory.

## Alternatives and consequences

Blind retry, shorter authorization waits, hidden sends and choosing the first tab
were rejected. The native/API/shared contract is extended additively and requires
reloading extension/native host and reconnecting MCP. Activation must be validated
with synthetic tabs/UI; no real sends in automated tests. The account remains a
local namespace rather than verified WhatsApp session credentials.
