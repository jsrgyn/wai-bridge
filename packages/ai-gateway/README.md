# @wai-bridge/ai-gateway

AI processing boundary for the local REST API. The gateway does not open SQLite. `AIMessageStateService` uses authenticated Local API operations backed by a per-consumer row and a time-bounded lease. Notifications are hints; `AIEventConsumer.recoverMissedEvents()` pages persisted events, and `AIProcessingWorker.runRecovery()` claims unprocessed messages for recovery. A message becomes READ only after successful processing and explicit ACK.

## State and recovery

- Each `(messageId, consumerId)` has independent `UNREAD`, `CLAIMED`, `READ`, or `FAILED` state.
- Claim leases default to 60 seconds and can be configured from 1 second through 24 hours. An expired lease can be reclaimed with a new token. Attempt counts persist across process restarts and drive the bounded retry policy.
- `GET` is read-only. The recovery query includes messages with no consumer state yet, FAILED messages, and expired CLAIMED leases, ordered by observed timestamp and UUID.
- State can be inspected per consumer through `AIMessageStateService.get()`; missing consumer rows are returned as virtual `UNREAD` without writing them.
- ACK and failure transitions require the current consumer, claim token, and a non-expired lease. Invalid processing results fail with `AI_RESULT_INVALID` without ACK. A failed post-ACK audit does not downgrade a durable READ state.
- Notification receipt never suppresses later processing. `processEvent` uses durable per-consumer READ state to recognize completed work; claims serialize concurrent attempts. Resolution, claim, processing, or ACK failures allow a later delivery of the same event. Only message aggregates with UUID message IDs are accepted; staging observation events are ignored.

## Providers and media

`AIProviderAdapter` supports injected cloud, local, and mock implementations. `MockAIProviderAdapter` is for synthetic tests only. The HTTP adapter validates response contracts, uses an abort timeout, requires HTTPS for cloud endpoints, and rejects media unless `allowExternalMedia` is explicitly true. Credentials are injected at runtime and are never logged.

Audio, image, and document services validate MIME and a 25 MiB maximum. Text documents are decoded locally. PDF/DOCX extraction requires an explicitly configured provider; no arbitrary files are opened. `VideoAnalysisService` uses `FFmpegVideoTranscoder`, which writes caller-supplied bytes into a fresh mode-0600 temporary directory, calls `ffmpeg` with fixed argument arrays (never a shell), caps extracted audio to 30 seconds and a video frame to 768px, applies a timeout, and removes the directory. Missing tools or unsupported media surface as limitations/errors; no transcript or description is fabricated. Original content references are included in every result.

All message content is untrusted data. Providers must treat it as content for analysis, never as operational instructions. Processing results are not ACKed on failures. `AIProcessingAuditService` records IDs, provider, references and error codes, not message text or media bytes.

## API and configuration

Construct `LocalAIAPIClient` with `baseUrl: http://127.0.0.1:47831`, the same `WAI_BRIDGE_API_TOKEN` configured on the Local API, and optional timeout (100–30000 ms; default 5000). Only localhost HTTP is accepted. The token currently represents the Local API's single full-access principal; per-tool API scopes are not implemented.

Current media API returns metadata only and does not provide bytes. The caller must explicitly supply bytes to an analysis service; this package does not load `storageKey`, path, or file content on its own.

## Tests

`pnpm --filter @wai-bridge/ai-gateway test` uses synthetic events/media and mock fetch/provider/transcoder. It never connects to a WhatsApp account or external AI provider.
