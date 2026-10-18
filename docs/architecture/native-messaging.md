# Chrome Native Messaging and macOS bridge

The extension uses persistent `chrome.runtime.connectNative('com.wai_bridge.mac_agent')`. Chrome launches the registered executable. Its origin argument and the host manifest's `allowed_origins` are checked against one configured extension ID.

Messages are UTF-8 JSON with a 32-bit little-endian byte-length prefix. Protocol version 1 accepts `HELLO`, `HEARTBEAT`, `STATUS_REQUEST`, and `CAPTURE_OBSERVATION`. Captures require a successful HELLO and the matching extension instance ID. The host validates the Zod envelope and forwards the observation to authenticated `POST /api/observations` on loopback. `CAPTURE_RESULT` includes observation ID, persisted event ID, and duplicate flag. An API failure returns a bounded error; the extension retains the queued observation for retry. No shell or send command is exposed.

Heartbeats refresh connectivity through `POST /api/extension/state`. The mac-agent never opens SQLite. The [Chrome Native Messaging documentation](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) defines macOS registration, origin argument, and process lifecycle.

Host input is capped at 64 MiB and output at 1 MiB. `stdout` carries framed protocol bytes only. Diagnostics go to `stderr` without tokens or message content. The API client accepts only a schema-validated loopback HTTP origin.
