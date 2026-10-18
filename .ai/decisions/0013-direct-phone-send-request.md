# ADR 0013 — Request a send directly by phone number

2026-10-18. Experimental implementation.

The user requests sending by number and text without a pre-existing conversation
UUID. Add whatsapp_send_to_number and an authenticated phone-intent endpoint.
Validate international numbers; do not guess DDI. Account may be explicit; otherwise
select only a single recently polled, opted-in local account (15 seconds). Store
these small routing heartbeats in wa_sync_state under a dedicated scope per
extension instance. The local account namespace remains a declaration, not a
verified WhatsApp login identifier. No session credentials are inspected.

Persist the outbox intent before searching. It contains the requested phone and
chosen local account, but no fabricated confirmed contact or conversation UUID.
The optional conversationId in commands distinguishes this unbound intent. Reuse
the existing phone search, visible profile proof, authorization, durable SENDING,
lease and outcome handling. No result/ambiguous result/incorrect profile means no
send. No private deep links, APIs, contact creation or historical scan fallback.

Idempotent replay compares the normalized original phone request before selecting
an active account again, so a retry does not rebind the recipient/account. Phone
intents share the extension-send idempotency scope and interface lease. UNKNOWN
is never automatically retried. Test only synthetic data/UI.

A previously open profile can be closed through its unique visible Fechar/Close
button before searching, provided there are no editable fields. This supersedes
the earlier requirement to start with the profile closed. The close control was
inspected on the real UI; opening/closing that panel did not send any message.
