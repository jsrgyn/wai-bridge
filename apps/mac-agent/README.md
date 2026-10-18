# macOS Native Bridge

The mac-agent is a Chrome Native Messaging host and transport bridge. Chrome starts the host process on `connectNative()` and owns its stdin/stdout pipes. The host does not open SQLite, listen on a port, execute shell commands, or connect to WhatsApp; it forwards validated observations to the authenticated Local API.

## Protocol v1

All envelopes are Zod validated in `packages/shared/src/native-messaging.ts`. Chrome's framing is a 4-byte little-endian unsigned byte count followed by UTF-8 JSON. The host accepts at most 64 MiB inbound and emits at most 1 MiB outbound. `stdout` is reserved for framed messages; diagnostics go to `stderr`.

Allowlisted extension requests are `HELLO`, `HEARTBEAT`, `STATUS_REQUEST`, `CAPTURE_OBSERVATION`, `SEND_POLL` and `SEND_PROGRESS`. Replies include `HOST_STATE`, `STATUS_RESULT`, `CAPTURE_RESULT`, `SEND_POLL_RESULT`, `SEND_PROGRESS_RESULT` and structured `ERROR`. A capture requires a successful HELLO with the same extension instance ID. The host forwards the observation to `POST /api/observations` and acknowledges only after the API persists it. The send envelopes forward scoped claims/progress to the API; the extension executes the visible UI action. There is no shell, arbitrary command or direct database operation in this protocol. See [extension sends](../../docs/operations/extension-sending.md). The host validates the caller origin argument against the single extension ID stored in its private config. The host manifest independently has one `allowed_origins` entry.

`HELLO` and heartbeats update `/api/extension/state` with the extension instance UUID and UTC timestamp. The API authenticates the host's local bearer token and persists state through `ExtensionStateRepository` in `wa_extension_state`. SQLite remains owned by Local API. If API is unavailable, heartbeat is still acknowledged over stdio and a later heartbeat retries state persistence.

## macOS development install

1. Load `apps/chrome-extension/dist/` as an unpacked extension in Chrome and copy its 32-character ID from `chrome://extensions`.
2. Create a high-entropy API token of at least 32 characters. Keep it outside the repository.
3. Ensure the Local API is reachable on loopback; default is `http://127.0.0.1:47831`.
4. Run from the repository root:

   ```sh
   export WAI_BRIDGE_EXTENSION_ID='your-32-character-extension-id'
   export WAI_BRIDGE_API_TOKEN='your-local-api-token'
   ./apps/mac-agent/scripts/install-macos.sh
   ```

   To use another loopback API port, set `WAI_BRIDGE_API_ORIGIN` before install.
5. Restart Chrome. The installer writes the user-level Google Chrome host manifest under `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`, creates private host config and launch scripts under `~/Library/Application Support/WAI Bridge/`, then loads `com.wai-bridge.local-api` as a user LaunchAgent.

The host config and manifest are created with mode `0600`, and the support directory with `0700`. The local API LaunchAgent uses `RunAtLoad` and `KeepAlive`; the Native Messaging host is instead started and stopped by Chrome as its port lifecycle requires. API logs are in the private support directory. Native host diagnostics use stderr, which Chrome captures in its extension diagnostics.

Uninstall registration and the LaunchAgent while retaining the DB/config:

```sh
./apps/mac-agent/scripts/uninstall-macos.sh
```

Pass `--purge` only when you also intend to delete the saved API token config. Database files remain for explicit user-managed backup/removal.

## Development and tests

```sh
pnpm --filter @wai-bridge/mac-agent build
pnpm --filter @wai-bridge/mac-agent typecheck
pnpm --filter @wai-bridge/mac-agent lint
pnpm --filter @wai-bridge/mac-agent test
```

Tests use synthetic framed stdin/stdout streams, fake API responses, and an in-memory/temporary SQLite database through the Local API suite. They cover observation forwarding and duplicate acknowledgements without installing a host manifest, loading launchd, using a real extension ID, or connecting to WhatsApp.
