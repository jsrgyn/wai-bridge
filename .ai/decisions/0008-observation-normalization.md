# ADR 0008: Normalize observations without asserting external identity

- Date: 2026-10-18
- Status: Accepted for local synthetic validation

## Context

ADR 0004 stages visible observations. The current contract has no stable account,
contact, conversation or message identifier. Labels are untrusted, non-unique hints.
The user requested integration of observations with contacts/conversations/messages.

## Decision

The Local API normalizes each observation transactionally with staging and events.
A mapping table links the observation to internal conversation, optional inbound
sender contact, and optional message. One observation gets its own conversation;
labels never merge identities. Connector `visible-ui-observation`, account scope
`extension-instance:<UUID>` and `identityStatus: UNKNOWN` explicitly describe this
limited provenance. The extension instance is not a verified WhatsApp account.
Outbound messages do not create a recipient or self contact from a sender label.

Only MESSAGE observations with a known direction become messages. Unknown direction
remains staged with DIRECTION_UNKNOWN. Activity creates no message. Media hints
produce unavailable metadata, never bytes. AI state starts UNREAD. The original
capture event remains, and a new message event references the actual message UUID.
Consumers reject capture-observation aggregates as message work.

Retries of the same observation reuse all records; conflicting payloads fail.
New observation IDs are not collapsed by equal text/name/time. No historical scan
or automatic backfill runs on startup. Explicit retransmission of a staged observation
can normalize it. Existing client request/response contracts remain unchanged.

## Alternatives considered

- Merge by visible label: rejected because homonyms and renames corrupt identity.
- Infer direction or sender: rejected because it invents evidence.
- Add stable external IDs to the observer: deferred until a supported identity
  source exists. No private protocol or session data is consulted.

## Consequences

MCP can query normalized records, with sourceObservationId and unknown identity.
Conversation history is fragmented per observation until an explicit reconciliation
contract exists. These contacts remain ineligible for outbox recipient verification.
This closes the local persistence/query path, not production DOM compatibility or
stable WhatsApp identity. Six existing migrations remain unchanged; migration 007
adds only provenance links. Backup restore accepts schema 7.
