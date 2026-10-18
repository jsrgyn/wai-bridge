# Architecture overview

The repository uses pnpm workspaces. Applications live in `apps/`; reusable modules live in `packages/`.

Intended dependency direction: `shared` is foundational; `events`, `database`, `media`, and `whatsapp-core` may depend on shared contracts; `ai-gateway` and `mcp-server` compose lower-level packages; apps compose packages. Avoid reverse dependencies from packages into apps.

This is a structural guide only. No runtime integration or business rules are defined.
