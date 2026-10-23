# Estado verificado do projeto

Atualizado em 2026-10-23. A linha principal de implementação usa SQLite schema 17 e migrations aditivas. O workspace tem extensão Chrome, agente macOS, Local API e servidor MCP compiláveis. Contratos entre fronteiras usam Zod; o servidor MCP acessa a Local API em localhost, não abre o banco.

## Capacidades implementadas

- Captura incremental e telemetria limitada ao conteúdo/metadados renderizados na interface; fila local durável com limites, ACK persistido e sinalização de lacunas.
- Reconciliação de até 50 mensagens visíveis por solicitação explícita, fila de revisão/pendências, estágios e confirmação separada da leitura do WhatsApp.
- Consulta paginada do catálogo de contatos local, filtros por nome/apelido/relação e período; cadastro e edição confirmados pelo usuário.
- Lotes seriais baseados em lista congelada e autorizada, relatório, cancelamento, retomada e retry apenas de falhas, com políticas por conversa.
- Painel de operações para status, contatos, propostas de referência, políticas, lotes e manutenção/backup verificado.
- Fila de envio contínua da extensão ([ADR 0024](../decisions/0024-continuous-extension-send-queue.md)): pedidos `QUEUED` atendidos por prioridade e criação, status e posição por pedido (API, MCP sem conteúdo de mensagem, painel), `WAITING_WHATSAPP` sem aba, SUPERVISED terminando em `DRAFTED` sem esperar clique, junção de rascunho do mesmo alvo, busca e gavetas devolvidas ao estado inicial, tempos configuráveis no painel (persistidos na API, sobrescrita por pedido validada), `chrome.alarms`, requeue antes de `SENDING` com pausa até `READY` e `UNKNOWN` depois.
- MCP com permissões por capacidade, e opt-ins de escrita/envio separados; logs operacionais sem conteúdo de mensagem por contrato.

## Limites conhecidos

- Fila de envio (ADR 0024): o fim em `DRAFTED` não rastreia se o usuário enviou o rascunho; AUTO para contato com rascunho pendente falha com `DRAFT_PENDING_ON_TARGET`; requeue/pausa sem limite de tentativas (pedido que derruba a aba pode pausar a fila até ser cancelado); o início do pedido apaga texto digitado na busca e texto alheio no campo de mensagem. O seletor de fechamento da gaveta "Nova conversa" e a quebra de linha por `insertLineBreak` foram verificados apenas no WhatsApp simulado, não no real.
- A extensão observa a UI acessível e não garante captura integral, estabilidade de seletores ou histórico completo. Dados renderizados continuam não confiáveis.
- Atualizações da extensão não substituem necessariamente a recarga de uma aba já aberta; a compatibilidade estrutural precisa ser verificada antes de operações visuais.
- Abrir uma conversa pode alterar os indicadores de leitura próprios do WhatsApp. Pedido de sincronização não confirma leitura pela IA.
- O runtime local não é uma integração de envio de produção: envio real não deve ser habilitado ou testado como se fosse garantido; AUTO é negado pelo verificador padrão.
- O MCP usa transporte stdio; clientes precisam reconectar após rebuild para descobrir ferramentas atualizadas.
- Backup local validado não substitui cópia independente/criptografada nem uma política de recuperação operacional.

## Validações registradas

Na implementação da fila de envio (schema 17, branch `feat/extension-send-queue`) foram observados, com exit 0: `pnpm build`, `pnpm lint`, `pnpm typecheck`; `pnpm test` (274 testes em 34 arquivos); `pnpm test:integration` (12 testes em 6 arquivos); unitários da extensão (40 testes em 10 arquivos); Playwright da extensão (132 testes em 13 arquivos), executado por arquivo (todos passam) e também sem filtro (132 passed em 16,7 min; não travou). O spec `phone-search` é lento (7,5 min isolado nesta branch; 29 testes em 15,0 min no commit anterior `db8d60b`), o que explica execuções longas sem filtro; não é regressão desta branch. Testes usam fixtures sintéticas e não executam envios reais.

Matriz de aceitação (critérios do desenho, seção 13), todos cobertos por testes passando:

1. Ordem e status final: `extension-send.test.ts` "serves three requests in creation order".
2. `DRAFTED` sem interação: e2e `visible-send` "supervised leaves text in composer, target chat open, reports DRAFTED without user click"; `content-send-protocol`.
3. Busca vazia e gavetas fechadas após validar: e2e `phone-search` (cenários `search-busy`, `new-chat-open`, `drawer-opens-late`, `directory-drawer-stays`).
4. Tela suja não falha: e2e `phone-search` `search-busy`/`draft`; `visible-send` "foreign text in target composer is erased when no earlier DRAFTED".
5. Junção: e2e `visible-send` "second supervised request to same target appends on new line".
6. `WAITING_WHATSAPP`: "no WhatsApp marks queue WAITING_WHATSAPP and READY restores QUEUED".
7. Reload e requeue/`UNKNOWN`: `extension-send.test.ts` "requeue keeps original position and pauses queue", "orphan from same instance requeued on poll without activeCommand", "SENDING lease expiry ends UNKNOWN and is never requeued"; e2e `runtime-invalidation` "reload mid-request…". O requeue de ponta a ponta usa o servidor simulado (lado da extensão em e2e, lado da API em unitário).
8. Tempos: `send-settings.test.ts` "update rejects out-of-range"; `local-api` "serves extension send queue, status and send settings with validation"; e2e `dashboard` "saves timing and reloads persisted values" e "rejects out-of-range input without request".
9. Suítes: resultados acima.
10. Rascunho editado preservado: e2e `visible-send` "user-edited draft is preserved and new text appended at end".
11. Prioridade com contagem 0: `extension-send.test.ts` "priority request jumps ahead of waiting ones but not the running one"; e2e `visible-send` "auto with countdown 0 sends immediately and reports SENT".

Para validar novamente após alterações, execute os comandos atuais listados no README; este registro não substitui uma execução nova.

## Privacidade da documentação

Este arquivo é versionado em um repositório público. Deve conter apenas fatos técnicos genéricos e resultados de testes sintéticos. Não registrar nomes de interlocutores, corpos de mensagens, números, e-mails, IDs de execução, caminhos absolutos de usuário, estado de uma conta real ou contagens obtidas de dados privados.

As regras públicas e o hook local agora bloqueiam arquivos privados conhecidos, artefatos binários de risco, identidade Git pessoal e segredos detectáveis em mudanças staged. Gitleaks não encontrou achados nos arquivos atuais; em repositório temporário, o hook passou com fixture segura e bloqueou caminho privado e uma chave sintética staged. O histórico Git publicado não foi reescrito; commits já existentes mantêm seus metadados e cópias remotas. Racional, alternativas, consequências e evidências desta proteção estão registrados no [ADR 0022](../decisions/0022-public-repository-privacy-hardening.md).

## Ferramentas de agentes

Em 2026-10-22 foram adicionados `.claude/settings.json` (habilita o plugin Superpowers no escopo do projeto e define permissões), `CLAUDE.md` (importa o `AGENTS.md` e adapta as convenções do plugin) e a entrada `.worktrees/` no `.gitignore`, conforme o [ADR 0023](../decisions/0023-superpowers-agent-workflow.md). Não houve alteração de código de aplicação. A instalação do plugin em cada máquina não foi verificada.
