# Chrome extension

Automatic visible-context capture now runs without manual binding when monitoring is ON.
Monitoring intent survives page reload. Manual references below remain optional.
See [automatic capture and its coverage limits](../../docs/operations/autonomous-capture.md). This does not guarantee account-wide capture or identity continuity after reload.


Experimental native-delivered sends are implemented in `src/commands/visible-send.ts`
and `src/background/send-bridge.ts`, separate from legacy synthetic controllers.
Require local popup opt-in, active monitoring, a confirmed open conversation, an
explicitly authorized MCP command and a durable SENDING acknowledgement before
the click. See [activation and limits](../../docs/operations/extension-sending.md).
No new permissions or private WhatsApp APIs are used.

User-confirmed identification is available in the popup: select/register a local
account, inspect the open Contact info or Group info panel, then explicitly bind a
visible international phone or a selected local group UUID. Bindings are memory-only
and conservatively invalidated on navigation/context changes. This does not start
monitoring or enable sending. See [identification procedure](../../docs/operations/conversation-identification.md)
and ADR 0009. Browser local choices and database identity links are separate stores.

Manifest V3 experimental observer for newly accessible WhatsApp Web interface changes. The user enables monitoring from the popup. The host match is limited to `https://web.whatsapp.com/*`; the extension requests `activeTab`, `storage`, and `nativeMessaging`, but no cookies permission.

The content script attaches `MutationObserver` to the currently visible message pane and conversation list. It ignores their existing descendants at startup and after a pane replacement. A newly added message can yield `CAPTURED`, `PENDING`, or `FAILED`; a new conversation row or unread indicator yields `DETECTED` without message content. Visible names are hints, never unique IDs. Media detection records only visible type hints and never downloads bytes.

The service worker validates messages from the WhatsApp Web origin, saves observations in a bounded local queue, and forwards them through Native Messaging to the macOS agent. An item leaves the queue only after the API confirms a persisted SQLite event ID. Duplicate submissions reuse the original event. The popup reports connection, generic activity summaries, and errors. Options control whether summaries are kept.

Selector mapping is experimental and has only been exercised against synthetic pages. WhatsApp Web may change its DOM, omit content, or rerender older items as new nodes. No complete capture guarantee is made. The observer does not navigate conversations, mark AI messages read, send messages, access app session storage, or intercept private protocols. See [observer contract](../../docs/architecture/whatsapp-observer.md).

From the repository root:

```sh
pnpm --filter @wai-bridge/chrome-extension build
pnpm --filter @wai-bridge/chrome-extension typecheck
pnpm --filter @wai-bridge/chrome-extension lint
pnpm --filter @wai-bridge/chrome-extension test
```

Automated browser tests use `tests/fixtures/whatsapp-simulator/` and no WhatsApp account.
# Chrome extension

The extension currently observes only synthetic fixtures and the experimental visible DOM adapter. Its outbox command controllers live in `src/commands/outbox-executor.ts`; `SyntheticConversationResolver`, `SyntheticRecipientVerifier`, `SyntheticMessageComposer`, and `SyntheticSendResultVerifier` operate only on `data-wai-*` markers. They are not configured in the extension service worker and do not run on WhatsApp Web.

The executor validates command UUID/version and mode, claims each command through an injected idempotent persistence adapter, resolves exactly one conversation, verifies its synthetic recipient identity, and prepares the text. SUPERVISED stops at `WAITING_USER`. AUTO additionally requires explicit authorization and two local feature gates, shows a cancelable countdown, rechecks that the same conversation is still present, and only clicks a synthetic `[data-wai-send]` control. `SENT` requires a matching synthetic result marker and evidence reference; otherwise the outcome is `UNKNOWN`.

The legacy synthetic executor has no command delivery or result persistence transport of its own: the separate native send delivery is described in ADR 0010. This legacy executor is therefore a page-simulator implementation with injected persistence, not an operational bridge to `wa_outbox`/SQLite. Do not enable it on a real WhatsApp page. Real interface compatibility has not been evaluated; visible UI selectors can change without notice and no supported WhatsApp sending API is used. Tests run against `tests/fixtures/whatsapp-simulator/` and never send real messages.
