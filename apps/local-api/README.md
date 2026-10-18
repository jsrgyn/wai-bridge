# @wai-bridge/local-api

Fastify REST API and business-service boundary for the local system. `buildApp()` receives the Local API-owned SQLite handle and a local bearer token (minimum 32 characters). `/health` is public; all `/api/*` routes require the configured token. The production entry point binds only to `127.0.0.1`, requires `WAI_BRIDGE_API_TOKEN`, and closes the server/database on SIGINT/SIGTERM.

Controllers call services only; SQL stays in `packages/database` repositories. Reads do not change AI message state. Claims and ACKs use explicit state transitions; outbox endpoints persist/cancel command records and do not execute a real WhatsApp send. Media responses expose metadata only, never filesystem paths.

Current authorization is one local full-access principal, not per-tool/per-resource scopes. Configure token outside source control. Fastify logs redact URL, body, authorization, and cookie fields. The authenticated `POST /api/extension/state` endpoint persists mac-agent connectivity in SQLite. API contract draft: `docs/api/openapi.yaml`.
