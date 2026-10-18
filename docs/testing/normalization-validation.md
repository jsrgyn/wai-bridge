# Validação das correções e normalização — 2026-10-18

Escopo: REV-001/002/003, leases de falha IA, normalização de observações na Local API
e consultas pelo MCP. Dados sintéticos e bancos temporários/em memória; nenhuma
conta WhatsApp, envio real ou provider IA externo foi usado.

## Mudanças verificadas

- Resultado IA fora do schema termina em FAILED/RETRY com AI_RESULT_INVALID, sem ACK.
- Repetição de evento após falha de resolução, claim, processamento ou ACK permite
  nova tentativa. Apenas READ persistido por consumidor representa conclusão;
  recebimento de notificação não deduplica trabalho como concluído.
- Audit sink falhando depois de ACK não rebaixa READ. Fail com lease expirada é negado.
- Outbox mantém lease na preparação, verifica owner/deadline nas transições e
  encerra preparação interrompida em FAILED, sem repetir envio. Poll posterior
  recupera lease que ainda estava vigente no restart. Countdown ativo não é
  cancelado pelo recovery periódico; worker antigo não altera claim de outro owner.
- Staging, projeção, UNREAD, metadados de mídia e eventos são atômicos. Conflito
  de observação resulta em 409; falha no segundo evento reverte toda a gravação.
- Mensagens/conversas normalizadas expõem sourceObservationId e identidade UNKNOWN
  nas consultas MCP. Contatos de sender são UNKNOWN e inelegíveis para envio.
- Nomes/conteúdos iguais não unem identidades. Cada observação tem sua própria
  conversa; identidade externa e agrupamento de histórico continuam pendentes.
- Direção desconhecida permanece staged; atividade não fabrica mensagem. Hints de
  mídia não significam bytes disponíveis. Consulta não confirma leitura IA.
- Retransmissão explícita de staging antigo normaliza uma única vez. Startup não
  varre observações antigas. Eventos de observação não são tarefas de mensagem IA.

## Evidências executadas

| Comando/check | Resultado |
| --- | --- |
| `pnpm build` | Passou nos nove projetos aplicáveis |
| `pnpm lint` | Passou; aviso ESM preexistente |
| `pnpm typecheck` | Passou |
| `pnpm test` | 104 testes em 11 arquivos passaram |
| `pnpm test:integration` | 1 teste host → API → SQLite → consulta passou |
| Smoke Node isolado de backup/restore | Scripts backup-database e restore-database passaram; schema 7 preservou mensagem normalizada, integrity ok e zero violações FK |
| `git diff --check` | Passou |
| Ativação local após backup consistente | LaunchAgent reiniciado; diagnose confirmou schema 7/integrity ok/health disponível e MCP whatsapp_status retornou ok/database connected/schemaVersion 7 |

Os seis cenários novos em `packages/mcp-server/test/capture-integration.test.ts`
usam o protocolo MCP in-memory, cliente HTTP real do pacote e Fastify Inject.
Validam consultas por conversa, recentes, unread, grupos, contatos e metadados de
mídia; não apenas presença de linhas no SQLite. A migration 007 foi aplicada
sobre schema 6 sintético preservando dados e checksums anteriores.

Esta validação não substitui revisão independente nem comprova DOM real,
identidade estável, WebSocket integrado, ingestão de bytes ou execução de envio.
REV-004 e demais pendências de segurança/produção das auditorias anteriores não
foram declaradas resolvidas por esta tarefa. Ver ADR 0008.

Backup anterior à atualização: `~/Library/Application Support/WaiBridge/backups/wai-bridge-20261018T040920Z.sqlite`.
Nenhuma fixture foi inserida no banco do usuário. Houve indisponibilidade transitória
durante startup, seguida de confirmação da API disponível e do schema atualizado.
