# ADR 0003: Native Messaging protocol v1

- Status: Proposed, implemented behind localhost and simulator-only behavior; pending independent security review.
- Date: 2026-10-17.
- Context: WB-012 needed an explicit extension-to-mac-agent transport before either side could integrate. The prior protocol status was unresolved.
- Decision: Use Chrome's Native Messaging stdio framing (UTF-8 JSON preceded by a 32-bit little-endian byte length on macOS), protocol version `1`, shared Zod schemas in `packages/shared`, a single configured extension origin, and a bounded request allowlist: `HELLO`, `HEARTBEAT`, `STATUS_REQUEST`. Host replies are `HOST_STATE`, `STATUS_RESULT`, and enumerated `ERROR`. No capture payload, message-send, arbitrary shell, or DB command is allowed.
- State: The host persists connectivity only through bearer-authenticated `POST /api/extension/state`; Local API remains SQLite owner. The Chrome extension reconnects with capped exponential delay. Chrome controls host process startup/shutdown; launchd keeps the local API available.
- Limits: Capture delivery, durable retries for observations, command authorization for future product operations, and staleness/lease policy for extension state remain undefined and disabled.
- Security: The host manifest has exactly one origin; runtime origin argument must match config. Private API token is stored outside the repository with owner-only file permissions. API destination is restricted to loopback HTTP. Host diagnostics use stderr; stdout is framed protocol only.
- Consequences: The transport can prove host/API reachability but does not make the extension a WhatsApp connector. Changes to envelope compatibility require a new protocol version and contract tests.
- Evidence: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, mac-agent tests, and extension Playwright suite were executed for this revision.
