# @wai-bridge/outbox-engine

Transactional state machine and dispatcher for persisted send requests. This package includes no WhatsApp integration. The Local API starts the dispatcher with `DenyAutoAuthorizationVerifier` and `SimulatedSendExecutor`; AUTO therefore fails closed in this phase. A simulated executor result is tagged `simulated:<commandId>` and never means a real message was sent.

## Flow

- `OutboxService.create()` validates and persists an idempotent request in `REQUESTED`; omitted mode defaults to `SUPERVISED`.
- Dispatcher moves requests through `QUEUED`, `CLAIMED`, recipient verification and `COMPOSED`. Contacts that are missing or have identity status `PARTIAL`/`UNKNOWN` fail without invoking an executor.
- SUPERVISED reaches `WAITING_USER`; it does not call a send executor. `recordManualResult()` can record `SENT` only with an evidence reference, or record `UNKNOWN`/`FAILED` explicitly.
- AUTO requires `explicitAuthorization: true` plus a separately composed `AuthorizationVerifier`. It persists `WAITING_AUTO_SEND`, waits five seconds with an abort signal, then acquires the singleton interface lease before persisting `SENDING` and calling the injected executor.
- Executor success, known failure, timeout, or uncertain exception are persisted as `SENT`, `FAILED`, or `UNKNOWN`. UNKNOWN is terminal and never retried.
- `recoverAfterRestart()` requeues expired pre-send claims, changes expired SENDING to UNKNOWN, and cancels interrupted AUTO waits. It never resumes a delayed send after restart.
- `OutboxCancellationService` cancels all pre-SENDING states and aborts an in-process AUTO wait. SENDING and terminal states cannot be cancelled.

Every transition is persisted with history and audit in the same SQLite transaction. Command leases and a database-wide send-interface lease prevent duplicate workers from claiming the same command or concurrently using the single interface. `dispatchOne()` processes at most one command per call; no bulk send operation exists.

## Extension points

Inject `RecipientResolver`, `AuthorizationVerifier`, `SendExecutor`, and `Waiter`. The bundled `DatabaseRecipientResolver` accepts only a known identity. `DenyAutoAuthorizationVerifier` always denies. `SimulatedSendExecutor` is the only bundled executor. Do not supply a real send executor in this phase. The Local API currently does not provide trusted authorization proofs; an AUTO verifier that only checks WhatsApp message content is invalid.

## Tests

`pnpm --filter @wai-bridge/outbox-engine test` uses temporary SQLite databases, synthetic contacts and simulated executors. No WhatsApp account or real send is used.
