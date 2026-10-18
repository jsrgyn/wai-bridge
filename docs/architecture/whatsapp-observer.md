# Experimental WhatsApp Web observer

## Scope and flow

Monitoring is manually enabled in the popup. The content script attaches narrow `MutationObserver`s to the open message pane and conversation list. It does not read existing message descendants at activation or after a pane replacement. There is no full conversation scan, navigation, session storage access, cookie access, private protocol interception, or message send path.

`ConversationObserver` emits `CONVERSATION_ACTIVITY` with `DETECTED` when a row is added or a visible unread indicator changes. An indicator never implies message content. `MessageObserver` handles newly added message nodes in the open pane. `ContactDetector` reads visible conversation and sender labels, `GroupDetector` uses visible group hints, and `MediaDetector` records visible media kinds only. `CaptureStateManager` deduplicates node observations and unread counts for the current page. Labels are not stable identity keys; group conversation and sender are separate fields.

| State | Meaning |
| --- | --- |
| `DETECTED` | New activity is indicated; content is not known. |
| `CAPTURED` | Visible text was extracted from a newly added message node. |
| `PENDING` | A message node was added but text is unavailable. |
| `FAILED` | Extraction failed after a relevant node was added. |

The shared Zod contract carries a UUID observation ID, UTC timestamp, optional visible labels, `INBOUND`/`OUTBOUND`/`UNKNOWN` direction, optional text, content availability, and media type hints. The service worker stores observations in a queue before asking the local agent to submit them. The agent authenticates to the loopback API, which stores staging, normalization and events in one SQLite transaction. ADR 0008 gives each observation its own internal conversation with UNKNOWN identity, without merging labels. Known-direction messages become queryable through MCP, with UNREAD state and provenance. Unknown direction remains staged; activity never manufactures message content. Events carry IDs/classification, not text. `GET /api/observations/{id}` requires the local bearer token. Only explicit consumer ACK marks READ.

## Limits

The selectors use WAI synthetic attributes and tentative visible DOM selectors (`#main`, `#pane-side`, message containers, rows, and accessibility labels). They are not an official WhatsApp contract. Tests use only synthetic pages, so real page compatibility is unverified. A DOM change may hide data, cause `PENDING`/`FAILED`, or present old content as a newly inserted node. Some accessible activity may never appear in the open pane. No total capture guarantee is possible from this surface.

Observations are deduplicated by UUID across native/API retries, and by DOM node identity within one page. Two distinct DOM nodes showing the same content are not treated as the same message because no stable external message ID is available. The bounded extension queue holds at most 100 pending observations; when full it reports an error and cannot accept more. The content script retries a failed handoff a limited number of times. A crash before the service worker acknowledges storage can lose an observation.

Opening an unopened conversation may alter WhatsApp's own read indicator. Automatic navigation is therefore outside this observer and would require a separate, limited, explicitly authorized operation. No mechanism attempts to conceal automation.
