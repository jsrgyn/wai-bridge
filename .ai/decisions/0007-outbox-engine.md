# ADR 0007: Transactional outbox dispatcher with simulation-only execution

- Date: 2026-10-17
- Status: Accepted

## Context

The Local API persisted outbox requests and cancellations but had no queue state machine, leases, restart recovery, or send interface. This phase explicitly prohibits real sends. AUTO requires authorization independent of message content and an interruptible delay; SUPERVISED must stop at manual handoff.

## Decision

Add an outbox domain package backed by the API-owned SQLite repository. Persist every state transition and audit record; claim queued commands with a lease and serialize use of the single send interface with a separate database lease. Restart recovery requeues expired pre-send claims, marks expired SENDING as UNKNOWN, and cancels interrupted AUTO waits. `DenyAutoAuthorizationVerifier` is the runtime default. The only bundled executor is `SimulatedSendExecutor`; no WhatsApp adapter is included. Supervised commands end in WAITING_USER until an explicit result with evidence is recorded.

## Consequences

- UNKNOWN is terminal and never automatically requeued.
- Runtime Local API can advance SUPERVISED commands to WAITING_USER, but AUTO is rejected until a trusted authorization verifier is composed.
- A simulated result uses a `simulated:` reference and is not evidence of a real WhatsApp send.
- A real interface adapter and a trusted user authorization source remain future work and require separate security review.
