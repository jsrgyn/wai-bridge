# Resultados de validação

**Snapshot:** 2026-10-17. Comandos executados no workspace macOS local. Os avisos ESM do ESLint/Vitest e depreciação do Node/Playwright não bloquearam os comandos.

| Comando | Resultado observado |
| --- | --- |
| `pnpm lint` | Passou; ESLint completo. Aviso de configuração ESM typeless. |
| `pnpm typecheck` | Passou; `tsc --build`. |
| `pnpm test` | Passou: 86 testes em 11 arquivos. |
| `pnpm build` | Passou; 10 projetos buildáveis no workspace. |
| `pnpm test:integration` | Passou: 1 teste integração captura → API → SQLite/evento e duplicata. |
| `pnpm --filter @wai-bridge/chrome-extension test` | Passou: 3 unitários e 14 Playwright (17 total). Playwright usa fixture e Chrome instalado localmente. |
| `pnpm audit` | Passou: “No known vulnerabilities found” no momento da consulta. |
| `bash -n` nos scripts macOS | Passou nos seis scripts shell: install, uninstall, backup, restore, diagnose, update. |
| Smoke de `backup-database.mjs` + `restore-database.mjs` | Passou em temp dir: integrity `ok`, registro sintético preservado. |
| Smoke de schema SQLite | Passou: 6 migrations, 18 índices, integrity `ok`, 0 violações FK. |
| `diagnose-macos.sh` | Passou como read-only; confirmou que plist, Native Messaging manifest, dados, logs, token e DB não estão instalados e API não está ativa. |

## Cenários cobertos por pacotes

- **Database:** migrations 1–6 idempotentes, checksum, FK, transação rollback, WAL/reabertura, backup consistente, FTS, idempotência de comandos, estados/leases de IA.
- **Events:** emissão, persistência, deduplicação, notificação, falha, timeout, retry/DLQ, lease e recuperação.
- **AI:** notificação perdida/duplicada, recuperação, claim por consumidor, ACK, falhas, timeout/retry e áudio/imagem/vídeo/documento simulados.
- **Outbox:** AUTO e SUPERVISED com simulador, default, cancelamento, falha, duplicidade, restart, UNKNOWN e concorrência.
- **Media:** bytes sintéticos de áudio/imagem/vídeo/documento, cache, hash, retenção, disco indisponível, traversal/symlink.
- **API/MCP/Native host:** rotas autenticadas, schemas, tools, Native Messaging allowlist/framing e fluxo captura integrado sintético.
- **Extension E2E:** observação e executor em fixture individual/grupo; nenhum WhatsApp real.

## Não executado / não demonstrado

- Nenhum LaunchAgent foi carregado ou instalado em runtime; não se declarou inicialização persistente operacional.
- Nenhuma conta WhatsApp real, envio real, DOM real, captura completa, notificação WebSocket executável ou provedor de IA real.
- Não se executou restauração sobre dados de usuário; smoke foi inteiramente temporário.
- `pnpm audit` é um snapshot; não substitui análise de dependências, revisão de código ou monitoramento contínuo.
