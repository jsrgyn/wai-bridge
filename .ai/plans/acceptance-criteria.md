# Critérios de aceite e rastreabilidade

## Critérios globais objetivos

- AC-01: `pnpm install`, `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test` e integração/e2e aplicável executam com sucesso em runtime baseline registrado; anexar saída CI/local.
- AC-02: todos contratos de fronteira possuem schemas Zod e testes de payload válido/inválido.
- AC-03: nenhuma dependência cíclica entre packages/apps; extensão sem acesso SQLite; MCP sem acesso DB direto.
- AC-04: SQLite é única persistência relacional; eventos/comandos persistem antes de efeitos/notificações.
- AC-05: integração é comprovada por simuladores offline, sem sessão/conta WhatsApp e sem envio real.
- AC-06: captura não percorre histórico; estados indisponíveis/identidade desconhecida são representáveis e não se promete cobertura total.
- AC-07: somente confirmação explícita marca leitura IA como `READ`.
- AC-08: envio padrão `SUPERVISED`; AUTO condicionado a go/no-go, comando explícito, destinatário validado, cinco segundos canceláveis, pre-persistência e nenhum retry automático quando resultado desconhecido.
- AC-09: localhost/auth/origin/permissions, auditoria, redaction, proteção local e retenção têm testes/documentação.
- AC-10: security review e QA review são independentes do executor; achados críticos/altos fechados ou exceção formal aprovada.
- AC-11: todos requisitos FR/NFR rastreados abaixo com ticket, suite e evidência.
- AC-12: instalação/upgrade/uninstall/backup/restore/recovery documentados e ensaiados em macOS Apple Silicon.

## Matriz FR

| Requisito | Tarefa(s) | Evidência de aceite |
|---|---|---|
| FR-01 captura somente novidades | WB-017–019 | Playwright DOM simulator prova zero histórico enumerado |
| FR-02 identidade/conteúdo indisponíveis | WB-002, WB-019 | fixtures unknown/partial e assertions |
| FR-03 inbound/outbound observáveis sem alegar cobertura | WB-019 | direction/source + incomplete marker contract tests |
| FR-04 persistir eventos/comandos antes de efeito; SQLite exclusivo | WB-005–008 | DB integration/atomicity e arquitetura graph check |
| FR-05 mídia em FS + metadata DB | WB-010 | temp FS traversal/retention tests |
| FR-06 API REST lógica de negócio, via mac agent | WB-008, WB-013 | route/auth + bridge simulator integration |
| FR-07 WebSocket notifica, persistência é fonte | WB-007 | crash/reconnect/cursor simulator |
| FR-08 MCP autorizado sem bypass | WB-015–016 | tool allowlist + API spy, ausência acesso DB |
| FR-09 estados leitura e confirmação explícita | WB-009, WB-016 | transition tests, no auto-READ |
| FR-10 modos SUPERVISED/AUTO | WB-011, WB-020–021 | simulated workflow, default and cancel/fake clock |
| FR-11 resultado verificável, sem repetir desconhecido | WB-011, WB-021 | unknown state retry count = zero |
| FR-12 Zod e auditoria | WB-002, WB-006, WB-008, WB-022 | boundary schema suite + audit/redaction tests |

## Matriz NFR

| Requisito | Tarefa(s) | Evidência |
|---|---|---|
| NFR-01 local-first/no external DB/localhost | WB-001, WB-005, WB-008 | dependency scan + bind/auth test |
| NFR-02 strict/modular | WB-002–023 | typecheck + dependency graph + review |
| NFR-03 Zod/errors/logging | WB-002, WB-008, WB-022 | schema/error/log redaction tests |
| NFR-04 deterministic tests/no real send | WB-004, WB-023 | isolated CI, fake adapters, no account config |
| NFR-05 least privilege | WB-003, WB-013–015, WB-022 | permission/auth review and tests |
| NFR-06 credentials/files protected | WB-003, WB-014, WB-022 | filesystem/config scan and permissions test |
| NFR-07 retention/encryption assessment | WB-001, WB-010, WB-024 | ADR, policy tests, key handling decision |
| NFR-08 uncertainty/no complete-capture claims | WB-019 | unavailable/partial fixtures + docs review |
| NFR-09 cancellation/no unknown retry | WB-021 | fake clock and unknown outcome integration |
| NFR-10 platform/tool compatibility | WB-001, WB-014, WB-024 | macOS Apple Silicon CI/runbook evidence |
