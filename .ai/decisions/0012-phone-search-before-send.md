# ADR 0012 — Resolve an explicitly requested recipient through visible phone search

Date: 2026-10-18. Status: experimental implementation.

The user authorizes searching the visible WhatsApp contact input by number to
verify a recipient requested through MCP. Extend the existing persisted send request
with optional locateByPhone. The API resolves a stored direct-contact phone, not a
number/name supplied by message content. Reject missing phones and groups.

The native poll may claim this explicitly flagged request within the same local
account, even when a different conversation is open. Existing sends keep exact
reference matching. The command's original context/lease remains the authenticated
progress token; the executor separately verifies and latches the resolved visible
root/context for the recipient. No cross-account claims, mass sends or retries.

Search UI is a locator, not identity proof. Require one visible result, open it,
open its visible profile and match the full normalized international phone. Bind
execution to that new context and recheck the profile phone before composing and
before send. Names and search snippets never authorize sending. Ambiguity, wrong
phone/group, unavailable UI, drafts, existing search or user interference fail closed.

Keep popup opt-in, explicit command authorization, SUPERVISED/AUTO, five seconds,
durable SENDING and visible delivery evidence. Test only synthetic UI. Opening a
chat may change WhatsApp unread indicators; it does not ACK AI reading. No private
protocol, session state, credentials or indiscriminate history access is introduced.
