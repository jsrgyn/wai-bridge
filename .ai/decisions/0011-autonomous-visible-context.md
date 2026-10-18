# ADR 0011 — Automatic local references and resumable visible-UI monitoring

- Date: 2026-10-18
- Status: Accepted for experimental implementation

User requests capture without per-chat manual binding, including outgoing messages
synced from the phone. Preserve DOM-only access, no private session/protocol APIs
and no indiscriminate historical scan. Inspection found selected sidebar row and
rendered message dates, but list-item indices are positions, not stable identities.

Add UI_CONTEXT/VISIBLE_UI references: locally generated UUIDs scoped to the local
browser account namespace and selected live row/context. Names are labels and row
reuse guards, never global identity keys. Equal names in distinct rows stay distinct;
uncertain reuse creates another reference. These references are explicitly partial,
not official WhatsApp IDs and not proof of human identity. Manual references remain
available as an advanced feature. Earlier UNKNOWN data is not relinked by name.

ON is persisted as monitoring intent and restored through the authenticated
background/content handshake. Context snapshots cover root, title and selected row;
changes invalidate the current execution context and automatically establish a new
capture context. Phone-synced and browser-sent outgoing bubbles use the same
observation/normalization path as incoming ones. A context is registered over native
poll even when sends are disabled, with allowClaim=false. Sending retains explicit
per-command authorization and popup opt-in, and must match the current context.

Capture observes newly rendered accessible messages, never infers missing text.
Known older messages with recognized Portuguese UI dates are excluded after navigation.
Missing/ambiguous dates cannot establish complete coverage; inaccessible content remains pending.
No session survives as a claimed official identity: reload/row recycling can split
local references. Complete account-wide delivery/history cannot be guaranteed from
visible UI. Official supported integration would be required for that guarantee.
