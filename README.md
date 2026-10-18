# WAI Bridge

Local WhatsApp AI Integration Bridge. Initial TypeScript pnpm monorepo for a local Chrome extension, macOS agent, local REST API, SQLite persistence, events, and MCP integration.

## Requirements

- Node.js 24 LTS recommended (Node 26 is Current)
- pnpm 11.20.0
- macOS Apple Silicon for eventual native SQLite work

## Getting started

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

No WhatsApp connection, message sending, or business behavior is implemented in this bootstrap. See `docs/architecture/README.md` and module READMEs.
