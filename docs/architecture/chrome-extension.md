# Chrome extension boundary

The MV3 extension has a content script, service worker, popup, options page, and Native Messaging connection to the local macOS agent. Its only host match is `https://web.whatsapp.com/*`. The content script reads changes in the accessible interface after the user enables monitoring. It never opens SQLite or calls the REST API directly.

`ConversationObserver` monitors newly added conversation rows and unread indicator changes. `MessageObserver` monitors newly added message elements in the open pane. `ContactDetector`, `GroupDetector`, and `MediaDetector` extract only visible hints. `CaptureStateManager` suppresses duplicate nodes and unchanged unread counts within the current page. `EventPublisher` persists validated observations in `chrome.storage.local` before sending them to the native host and removes them only after a persisted event acknowledgement.

The initial observation and event are persisted atomically by the local API. The event payload contains the observation ID and capture state; the authenticated observation endpoint serves the full captured payload. This keeps message content out of WebSocket notifications. The extension does not modify AI read state or the WhatsApp UI.

This mapping is experimental and validated only with synthetic fixtures. See [observer details](whatsapp-observer.md) and [native transport](native-messaging.md).


## Outbox command execution (simulator only)

The extension contains typed controllers for receiving and preparing an outbox command in `src/commands/outbox-executor.ts`. The implementation is exercised against the local synthetic page with stable `data-wai-*` markers. It is not connected to the service worker or Native Messaging: the current agent protocol has no outbox polling, claim, transition, or result messages. Do not enable command execution on the real web client. The visible interface is unofficial and unstable, and its compatibility has not been validated.
