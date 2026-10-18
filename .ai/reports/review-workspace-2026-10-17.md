# Revisão técnica e de segurança — workspace WAI Bridge

- Data: 2026-10-17
- Escopo informado: `FASE` vazia; revisão ampla do código presente no workspace, com foco em API, MCP, Native Messaging/extensão, persistência, mídia, AI gateway e outbox.
- Parecer: **CHANGES_REQUIRED**
- Base Git: indisponível. A pasta de trabalho não contém `.git`; não foi possível inspecionar histórico, diff, branch ou atribuir os achados a um commit específico.
- Código não foi alterado durante esta revisão.

## Resumo

As suítes executadas passaram e o projeto compila, faz typecheck e lint. A revisão estática encontrou dois problemas de alta severidade no processamento de IA, que podem marcar mensagens como lidas sem resultado válido e descartar a oportunidade de reprocessar eventos após falhas transitórias. Há também uma lacuna de recuperação no outbox após crash em estados intermediários. O escopo amplo e a ausência de histórico Git limitam a aprovação por fase/commit.

Não foram encontrados, na inspeção realizada, segredos hardcoded, rotas de MCP para acesso direto ao SQLite, execução de comando derivada de conteúdo recebido ou envio WhatsApp real. Isso não equivale a pentest ou auditoria de runtime.

## Arquivos analisados

- Instruções/contexto: `AGENTS.md`, `.ai/context/*`, `.ai/plans/*`, `.ai/rules/*`.
- Requisitos e ameaça: `docs/requirements/*`, `docs/security/threat-model.md`, `docs/security/security-audit.md`.
- API: `apps/local-api/src/*`, `apps/local-api/test/api.test.ts`.
- Persistência e eventos: `packages/database/src/*`, `packages/events/src/*` e testes.
- Outbox: `packages/outbox-engine/src/*`, repositório SQLite e testes.
- IA e mídia: `packages/ai-gateway/src/*`, `packages/media/src/*` e testes.
- MCP: `packages/mcp-server/src/*` e testes.
- Extensão e host: `apps/chrome-extension/src/*`, `apps/mac-agent/src/*` e testes.

## Problemas encontrados

### REV-001 — Resultado de IA inválido ainda confirma a mensagem como READ

- **Severidade:** HIGH
- **Arquivo/função:** `packages/ai-gateway/src/processing-worker.ts`, `AIProcessingWorker.process`, linhas 16–21.
- **Descrição:** Quando `AIResultSchema.safeParse(result)` falha, o código apenas registra `PROCESSED` sem dados e segue para `state.acknowledge(...)`. Portanto retorno vazio, inesperado ou incompatível com o contrato encerra o estado como `READ`.
- **Impacto:** Conteúdo pode deixar de ser reprocessado apesar de não haver resultado de análise válido, contrariando confirmação explícita somente após processamento concluído.
- **Evidência:** O caminho `else` na linha 20 não lança erro; a chamada de ACK ocorre incondicionalmente na linha 21.
- **Correção recomendada:** Tratar falha de validação do resultado como erro de processamento: registrar código sem conteúdo, marcar `FAILED` usando o claim atual e seguir a política de retry. Só ACK após resultado validado e persistência/auditoria de conclusão bem-sucedidas.
- **Teste ausente:** resultado inválido do processador não deve chamar ACK e deve terminar em FAILED/RETRY.

### REV-002 — Deduplicação em memória pode suprimir reprocessamento após falha

- **Severidade:** HIGH
- **Arquivo/função:** `packages/ai-gateway/src/event-consumer.ts`, `AIEventConsumer.consume`, linhas 5–12; integração em `processing-worker.ts`, linhas 30–32.
- **Descrição:** O event ID é inserido no `seen` antes da resolução do trabalho e antes de claim/processamento/ACK. `processEvent` retorna `RETRY` ou `IGNORED` se essas etapas falharem, mas o evento repetido na mesma instância já é respondido como `duplicate` e não chega novamente ao worker. O conjunto também não é persistido entre reinícios.
- **Impacto:** Falha temporária ou crash entre consumo e ACK pode deixar mensagem sem processamento até outro mecanismo de recuperação ser explicitamente executado; a notificação repetida não oferece a recuperação prometida.
- **Evidência:** `seen.add` ocorre antes de devolver evento novo; duplicatas retornam sem chamar `resolve` ou `process`.
- **Correção recomendada:** Remover dedupe local como autoridade de conclusão ou manter estados `in-flight`/`completed` com remoção em falha; usar estado persistente/claim por mensagem e cursor recuperável como fonte de verdade. Somente deduplicar como concluído após confirmação durável.
- **Teste ausente:** mesmo event ID recebido novamente após erro de resolução, erro de claim e falha pré-ACK deve permitir recuperação sem ACK falso.

### REV-003 — Outbox não recupera crash em estados intermediários de preparação

- **Severidade:** MEDIUM
- **Arquivo/função:** `packages/outbox-engine/src/dispatcher.ts`, `dispatchOne` e `prepareAndDispatch`, linhas 27–32 e 33–52; `packages/database/src/repositories/outbox.ts`, `recoverExpired`, linhas 35–40.
- **Descrição:** Recovery cobre somente `CLAIMED`, `SENDING` e `WAITING_AUTO_SEND`. Depois de `CLAIMED`, o dispatcher grava `TARGET_VERIFIED` e `COMPOSED` sem lease. Um crash nesses estados deixa o comando permanentemente fora da seleção (`claimNext` seleciona apenas `QUEUED`) e fora de `recoverExpired`.
- **Impacto:** Pedido fica preso e não pode ser concluído nem recuperado automaticamente; estado/auditoria deixam de refletir processamento ativo ou terminal.
- **Evidência:** `claimNext` filtra `status='QUEUED'`; `recoverExpired` não seleciona `TARGET_VERIFIED` ou `COMPOSED`.
- **Correção recomendada:** Manter lease/owner até transição terminal de preparação, incluir estados intermediários no recovery com semântica segura, ou fazer a sequência inteira da preparação recuperável por transições idempotentes.
- **Teste ausente:** simular restart depois de cada transição persistida (`TARGET_VERIFIED`, `COMPOSED`) e provar que o pedido é retomado ou terminado com estado explícito.

### REV-004 — Cobertura de cancelamento não garante idempotency key

- **Severidade:** LOW
- **Arquivo/função:** `apps/local-api/src/app.ts`, rota `POST /api/outbox/:id/cancel`, linhas 189–192; `packages/mcp-server/src/server.ts`, ferramenta `whatsapp_cancel_send`, linhas 52–55.
- **Descrição:** A chave `idempotency-key` é validada na rota, mas não é passada ao controller/service nem armazenada. Repetição é atualmente tolerada por estado CANCELLED, mas a chave não oferece deduplicação/auditoria por operação conforme indicado pelo contrato da ferramenta.
- **Impacto:** Clientes não conseguem correlacionar de forma confiável retries da operação de cancelamento; a chave aceita cria aparência de idempotência contratual sem semântica efetiva.
- **Evidência:** `parse(IdempotencyKeySchema, ...)` é chamado e o retorno descartado; `cancelOutbox` recebe somente ID.
- **Correção recomendada:** Remover a chave do contrato se cancelamento permanecer idempotente por estado, ou persistir/validar chave e hash da operação com escopo definido.
- **Teste ausente:** repetição com mesma chave e conflito com chave reutilizada para operação distinta.

## Verificações de segurança e regras de negócio

- **Credenciais/logs:** API e MCP leem token por ambiente; logger da API redige authorization, cookie, URL e body. O host escreve mensagens de erro genéricas no stderr. Não encontrei credencial literal nos arquivos-fonte inspecionados.
- **Autorização:** API usa um token bearer local de acesso amplo; scopes por integração/operação permanecem ausentes conforme finding SEC-01 documentado. MCP desabilita escrita por padrão, mas habilitar `WAI_MCP_ALLOW_WRITES=true` dá acesso a criação/cancelamento via principal full-access.
- **MCP/prompt injection:** tools passam conteúdo como dados e não oferecem acesso SQL/filesystem; escrita exige opt-in e pedido explícito. Erros de tool repassam `error.message`, logo respostas internas de API/transporte podem ser expostas ao consumidor MCP; sanitizar erros internos e preservar somente códigos/mensagens públicas.
- **Native Messaging:** framing valida JSON/schema e origem Chrome allowlisted. Limite de entrada é 64 MiB e o leitor concatena chunks do stream antes de processar frames; avaliar limite de buffer incremental para evitar crescimento temporário elevado sob frame grande/incompleto.
- **Extensão:** permissões declaradas observadas são `activeTab`, `storage`, `nativeMessaging`; host é limitado a `web.whatsapp.com`. Fila possui limite de 100 entradas e retém até resposta com event ID. `readQueue` descarta silenciosamente itens inválidos sem gravar fila limpa, o que torna perda/diagnóstico de dados difícil; adicionar telemetria sem conteúdo e teste de corrupção de storage.
- **Captura/deduplicação:** evento e staging são gravados na mesma transação e observação repetida com payload idêntico é deduplicada. Inserção de mensagem aceita conflito de chave/external ID e retorna registro existente sem comparar o payload recebido; garantir que reutilização de chave com conteúdo divergente seja conflito, conforme contrato de dedupe.
- **Leitura IA/ACK:** ACK consumer-specific verifica claim token e lease vigente. `failForConsumer` verifica token, mas não verifica `lease_until > now`; um worker cujo lease expirou pode marcar FAILED antes de um novo claim rotacionar o token. Teste e alinhar a regra ao ACK, se lease expirada deve retirar autoridade do worker.
- **Outbox:** destinatário precisa ser KNOWN, SUPERVISED aguarda ação manual, AUTO exige verifier, delay cancelável e executor é simulado no runtime; UNKNOWN é terminal e não é repetido. Nenhum envio real foi observado ou executado.
- **Mídia/path traversal:** armazenamento usa nome gerado, limites, hash, diretórios privados e `O_NOFOLLOW` na leitura conforme inspeção e testes existentes. A API não expõe bytes/caminhos.
- **Prompt injection:** mensagem é tratada como dado nos contratos/regras. Não foi executada avaliação adversarial ponta a ponta com modelo real; provider real não foi chamado.

## Testes executados

| Comando | Resultado observado |
|---|---|
| `pnpm test` | Passou: 11 arquivos, 86 testes. Aviso Vite sobre config ESM/native. |
| `pnpm test:integration` | Passou: 1 arquivo, 1 teste. Aviso Vite sobre config ESM/native. |
| `pnpm --filter @wai-bridge/chrome-extension test` | Passou: 2 arquivos/3 unit tests e 14 testes Playwright. Avisos Node deprecation/`NO_COLOR`. |
| `pnpm --filter @wai-bridge/mac-agent test` | Passou: 1 arquivo, 6 testes. |
| `pnpm --filter @wai-bridge/mcp-server test` | Passou: 1 arquivo, 6 testes. |
| `pnpm build` | Passou para os 10 projetos aplicáveis do workspace. |
| `pnpm typecheck` | Passou (`tsc --build`). |
| `pnpm lint` | Passou. Aviso Node `MODULE_TYPELESS_PACKAGE_JSON` na configuração ESLint. |

Não foram executados testes com WhatsApp real, modelo/provider real, instalação/launchd ou pentest. Nenhum envio real foi feito.

## Testes ausentes ou frágeis

- Resultado inválido da IA sem ACK (REV-001).
- Retry do mesmo event ID após falha e recuperação de crash (REV-002).
- Restart em cada estado intermediário persistido do outbox (REV-003).
- Corrida entre expiração do lease e `failForConsumer`.
- Reutilização de idempotency/external ID de mensagem com payload divergente.
- Contrato de idempotência do cancelamento (REV-004).
- Limite de memória sob frame Native Messaging grande/incompleto.
- MCP não expor mensagens internas de exceção em falha de rede/servidor.
- Testes Playwright usam somente fixture sintética e marcadores `data-wai-*`; não validam seletor/compatibilidade de DOM real.

## Critérios de aceite e parecer

- Nenhum problema CRITICAL observado na inspeção limitada realizada.
- Há problemas HIGH sem correção nos fluxos de ACK/leitura e recuperação de eventos.
- Há problema MEDIUM de recuperação de outbox após crash.
- Suites e verificações executadas passaram, mas isso não cobre os caminhos descritos acima.
- Revisão não pode ser vinculada a um diff/commit, pois Git não está disponível nesta pasta.

**Parecer final: CHANGES_REQUIRED.** Não aprovar os módulos de processamento AI/eventos e outbox até corrigir REV-001 a REV-003 e adicionar testes de regressão. Reavaliar REV-004 e os riscos de principal local full-access/MCP como parte de revisão de segurança independente.
