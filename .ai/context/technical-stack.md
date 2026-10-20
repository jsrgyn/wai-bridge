# Stack técnica verificada

- Monorepo TypeScript strict com pnpm workspaces.
- Extensão Chrome Manifest V3, content script isolado, service worker e páginas popup/options/dashboard.
- Agente Native Messaging para macOS; API local Fastify sobre HTTP loopback.
- SQLite via better-sqlite3 e migrations aditivas; contratos de fronteira validados com Zod.
- Servidor MCP TypeScript SDK v2 por stdio, cliente HTTP restrito a localhost.
- Vitest para unitários/integração; Playwright para cenários de navegador sintéticos; ESLint e TypeScript para análise estática.
- Builds de TypeScript via `tsc -b`; build da extensão via esbuild e empacotamento em `apps/chrome-extension/dist/`.

Versões e limites de engine devem ser conferidos em `package.json`, manifests dos workspaces e lockfile, que são a fonte de verdade. Não inferir suporte para qualquer runtime/plataforma além dos requisitos documentados. O agente Native Messaging e os scripts de instalação são específicos para macOS; testes Playwright atuais apontam para Google Chrome no caminho configurado em `apps/chrome-extension/playwright.config.ts`.
