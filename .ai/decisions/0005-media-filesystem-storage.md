# ADR 0005: Media bytes on private filesystem, metadata in SQLite

- Date: 2026-10-17
- Status: Accepted for the media package

## Context

The existing `wa_media` table records message-linked metadata but no processing state or duration. The Local API owns SQLite; binary media belongs in local private storage. External SSD disconnection, retries, duplicate content, and retention must not overwrite arbitrary files.

## Decision

Keep media SQL in `packages/database` and expose the repository through `packages/media`. Add migration 004 for processing status, duration, verification, removal, and error metadata. Write only caller-supplied bytes to exclusive temporary files under a private root. Generate relative storage keys from detected media kind, UTC date, SHA-256, and a fixed extension. Use hard-link creation to avoid replacing existing files. Reuse a verified cached blob when hash, size, and MIME match. Require a marker for custom roots so an absent SSD does not silently redirect writes to a newly created mountpoint. Retention is explicitly configured in days and checks remaining references before deleting a shared file.

## Alternatives considered

- Store binaries in SQLite: increases DB size and backup scope.
- Accept a file path or extension from the browser: expands traversal and misclassification risk.
- Download unavailable media through internal WhatsApp mechanisms: outside the authorized capture surface.
- Add a bundled media parser: adds a large runtime dependency; an optional local `ffprobe` can supply duration for non-WAV formats.

## Consequences

Filesystem and SQLite cannot share a transaction. An interrupted write may leave an orphan blob or a stale `CACHING` row; repair/reconciliation remains operational work. Custom root provisioning must happen while the intended volume is mounted. `ffprobe` is optional, so some audio/video duration values remain null. No API upload/download route is introduced by this package.
