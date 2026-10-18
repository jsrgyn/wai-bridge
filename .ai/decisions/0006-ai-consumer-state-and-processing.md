# ADR 0006: AI state per consumer and local multimodal processing boundary

- Date: 2026-10-17
- Status: Accepted

## Context

The existing `wa_ai_message_state` has one row per message, no lease deadline, and cannot represent independent consumers. The Local API owns SQLite and is the only approved service boundary. Media metadata is available, but the Local API does not expose media bytes. Multimodal processing must not fetch arbitrary paths or send media to external providers by default.

## Decision

Add an additive `wa_ai_consumer_message_state` table keyed by `(message_id, consumer_id)` with claim token, expiring lease, durable attempt count, explicit ACK, failure, and recovery query. Keep the legacy aggregate message state for compatibility. AI Gateway talks to the Local API and accepts media bytes only through explicit injected inputs. Provider adapters declare whether media leaves the process; external media requires explicit configuration. Video extraction uses a bounded `ffmpeg` subprocess only against a private temporary file created from caller-supplied bytes.

## Consequences

- Notification remains advisory; API recovery queries are the source for missed work.
- Each consumer gets independent UNREAD/CLAIMED/READ/FAILED state.
- The existing Local API bearer token remains full access; granular authorization is not introduced here.
- Existing local-media API gap remains: no media bytes are made available by the gateway automatically.
