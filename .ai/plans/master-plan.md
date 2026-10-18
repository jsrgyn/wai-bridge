# Plano mestre de implementação — WAI Bridge

## Estado e princípios

Planejamento apenas; não implica que funcionalidades existam. Estado inicial das tarefas: `TODO`. Transições permitidas: `TODO → IN_PROGRESS → IN_REVIEW → DONE`; qualquer estado pode ir a `BLOCKED` com motivo e dependência identificados. `DONE` exige testes observados e critérios satisfeitos. Retorno de `BLOCKED` requer registro de desbloqueio. Um executor implementa; revisor distinto aprova.

Fontes normativas: `AGENTS.md`, `.ai/rules/`, `.ai/context/` e `docs/requirements/`. Regras de captura, privacidade e segurança prevalecem sobre conveniência.

## Donos por módulo

| Módulo | Responsável de execução | Revisão independente |
|---|---|---|
| Arquitetura/contratos compartilhados | Architect Agent | Security Agent + QA Agent |
| `packages/database` | Database Agent | Architect Agent + QA Agent |
| `packages/events` | Event Agent | Database Agent + QA Agent |
| `apps/local-api` | Backend Agent | Security Agent + QA Agent |
| `packages/media` | Backend Agent (contrato), Database Agent (metadados) | Security Agent + QA Agent |
| `apps/chrome-extension` | Chrome Extension Agent | Security Agent + QA Agent |
| `apps/mac-agent` | macOS Integration Agent | Security Agent + QA Agent |
| `packages/mcp-server` | MCP Agent | Security Agent + QA Agent |
| `packages/ai-gateway` | AI Processing Agent | Security Agent + QA Agent |
| Integração geral | agente nomeado por ticket, sem coedição | Architect Agent + QA Agent |

## Fases e gates

1. **P0 — decisões e contratos**: resolver contratos abertos listados em `dependencies.md`; publicar schemas Zod, IDs e ADRs. Gate: contratos revisados; sem API presumida.
2. **P1 — base de qualidade e banco**: preparar harness/simuladores e SQLite/migrações/repositórios. Gate: migração repetível em DB temporário, isolamento, backup/retention decididos.
3. **P2 — eventos e API local**: persistência-first, WebSocket e rotas/regras de leitura/auditoria. Gate: contract + integração com DB e clientes simulados; localhost/auth provados.
4. **P3 — media e operações supervisionadas**: cache seguro de mídia e fluxo `SUPERVISED`. Gate: sem envio automático; resultado só verificável.
5. **P4 — AI/MCP**: processamento de mensagens como dados, estados de leitura e ferramentas allowlisted via API. Gate: adversarial prompt tests e confirmação explícita.
6. **P5 — integração macOS**: bridge Native Messaging/IPC e instalação. Gate: simuladores extension/API, permissões mínimas, uninstall/recovery.
7. **P6 — extensão e captura de novidades**: implementar captura DOM acessível apenas em novidades, somente após simulator e bridge aprovados. Gate: Playwright offline demonstra que histórico não é varrido.
8. **P7 — AUTO condicionado**: só após decisão de segurança/viabilidade e aceite explícito do usuário para capacidade; persistência prévia, validação, delay de cinco segundos, cancelamento, efeito simulado. Gate: resultado desconhecido nunca repete.
9. **P8 — hardening/release local**: auditoria, retenção/criptografia, instalação/upgrade, threat review, runbooks e regressão completa. Gate final abaixo.

Ordem de integração respeita “contratos → DB/backend → simuladores → bridge/macOS → WhatsApp Web”. Módulos sem WhatsApp podem avançar por simuladores.

## Paralelismo e exclusividade

Somente executar em paralelo tickets com arquivos disjuntos e contratos congelados. Antes de começar, declarar dono e paths exclusivos no quadro. Nenhuma coedição em `packages/shared/**`, raiz/configuração, `apps/local-api/**`, `tests/fixtures/**` ou arquivos de contrato. Integrações exigem PR/commit base atualizado e handoff; agente implementador pausa enquanto o revisor atua. Ver matriz em `phases.md`.

## Checkpoints de qualidade

- **Q0**: requisitos e contratos mapeados para FR/NFR; ADRs abertos resolvidos ou explicitamente adiados.
- **Q1**: format, lint, typecheck, unit tests e build.
- **Q2**: integração DB/event/API usando SQLite temporário e simuladores.
- **Q3**: análise de segurança independente; nenhuma severidade crítica/alta sem mitigação aceita.
- **Q4**: E2E offline de extension↔mac bridge↔API, captura incremental, envio exclusivamente simulado.
- **Q5**: instalação macOS, backup/restore e recuperação interrompida ensaiados; todos FR/NFR rastreados.

## Recuperação de trabalho interrompido

Ao retomar: ler `AGENTS.md`, current-state, status e log de handoff da tarefa; conferir branch/diff e arquivos não commitados sem descartá-los; reexecutar comandos registrados; manter ID/status; anotar último checkpoint, evidência, arquivos tocados, próximo passo e bloqueio. Nunca marcar DONE por progresso parcial. Se proprietário indisponível, novo responsável recebe handoff documentado e não assume arquivos simultaneamente; primeiro congela estado, depois transfere ownership. Alterações de schema/API recebem migração/versão compatível ou plano explícito de rollback.

## Gate de aceite final

Todos critérios em `acceptance-criteria.md` satisfeitos, FR-01…FR-12 e NFR-01…NFR-10 mapeados com evidência, todas suites verdes em ambiente limpo macOS Apple Silicon, threat review sem blocker aberto, operação de envio somente conforme autorização explícita, documentação/runbooks e current-state atualizados. Nenhum dado pessoal real usado em testes.
