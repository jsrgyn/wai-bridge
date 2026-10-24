# Fila de envio contínua da extensão — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Todo pedido de envio entra numa fila durável com status próprio; SUPERVISED termina em rascunho pronto, AUTO envia; a extensão devolve o WhatsApp ao estado inicial, se recupera de quedas e tem tempos configuráveis.

**Architecture:** A Local API (SQLite) continua dona da fila e do estado (`wa_outbox`, kind `extension-send`). Uma migration aditiva introduz configurações de tempo, prioridade, chave de alvo e pausa da fila. A extensão continua executora: normaliza a interface, compõe/anexa rascunho e reporta progresso; o service worker passa a usar `chrome.alarms`.

**Tech Stack:** TypeScript strict, Zod 4, better-sqlite3, Fastify, Chrome MV3, Vitest 5, Playwright, MCP SDK.

**Spec:** `.ai/plans/2026-10-22-extension-send-queue-design.md`

## Global Constraints

- Local API é a única que abre SQLite; migration aditiva `017-send-queue.sql` (schema 17).
- Contratos entre fronteiras em Zod em `packages/shared`; nada de `any`.
- Nunca envio real em teste; WhatsApp simulado nas suítes Playwright; dados sintéticos (telefones `+5500000000xx`, nomes fictícios).
- Logs, flow logs, eventos e status nunca carregam texto de mensagem, telefone ou nome.
- `UNKNOWN` nunca é reenviado; cancelamento não é permitido a partir de `SENDING`.
- AUTO mantém os opt-ins atuais (painel `waiExtensionSendsEnabled`, `explicitAuthorization`, `allowExtensionSends` no MCP).
- Tempos (padrão / faixa): contagem AUTO 5000 ms / 0–30000; execução 60000 ms / 20000–180000; espera máxima na fila 1800000 ms / 60000–86400000 ou `null` (sem limite); conferência pós-envio 15000 ms / 5000–60000.
- Valor de tempo por pedido fora da faixa → erro de validação 400, nunca ajuste silencioso.
- Ordem da fila: `priority DESC, created_at, id`; prioridade 1 = AUTO com `autoCountdownMs = 0`.
- Antes de cada commit: `pnpm lint && pnpm typecheck && pnpm test`; o hook de privacidade deve passar.

## Review Focus

1. Usuário digitando no campo de outra conversa quando o pedido começa → texto apagado só na conversa alvo, nunca em outra conversa (Task 7).
2. Extensão reconecta com outro `contextId` enquanto um pedido está `COMPOSED` → pedido volta à fila sem duplicar rascunho já escrito (Task 3, teste `requeue keeps original position`; Task 7, anexo idempotente).
3. Configuração alterada no painel durante uma execução → só afeta pedidos ainda não reivindicados (Task 2).
4. Pedido prioritário (contagem 0) criado enquanto outro executa → não interrompe o atual; passa à frente apenas dos que aguardam (Task 3).
5. Fila pausada após interrupção e nenhum `READY` chega por horas → pedidos continuam `QUEUED`/`WAITING_WHATSAPP` até a espera máxima; nunca viram `FAILED` sem motivo (Task 3).

---

## Etapa 1 — Fila e status

### Task 1: Contratos compartilhados de fila e tempo

**Files:**
- Modify: `packages/shared/src/extension-send.ts`
- Test: `packages/shared/test/extension-send-timing.test.ts` (criar)

**Interfaces:**
- Produces:
  - `SendTimingSchema` = `{ autoCountdownMs: int 0–30000, executionTimeoutMs: int 20000–180000, queueMaxWaitMs: int 60000–86400000 | null, sendVerifyMs: int 5000–60000 }` (strict)
  - `DEFAULT_SEND_TIMING: SendTiming` com os padrões das Global Constraints
  - `SendTimingOverrideSchema = SendTimingSchema.partial()`
  - `resolveSendTiming(settings: SendTiming, override?: SendTimingOverride): SendTiming`
  - Campo opcional `timing: SendTimingOverrideSchema` em `ExtensionSendRequestSchema`, `ExtensionPhoneSendRequestSchema`, `ExtensionRecipientSendRequestSchema`
  - `ExtensionSendCommandSchema` ganha `timing: SendTimingSchema` e `appendToDraft: z.boolean()`
  - `ExtensionSendStepSchema` ganha `'DRAFTED'`
  - `ExtensionSendQueueStatusSchema = z.enum(['QUEUED','WAITING_WHATSAPP','CLAIMED','TARGET_VERIFIED','COMPOSED','WAITING_AUTO_SEND','SENDING','DRAFTED','SENT','UNKNOWN','FAILED','CANCELLED'])`
  - `activeStatus` do poll result passa a usar `ExtensionSendQueueStatusSchema.or(z.literal('REQUESTED')).or(z.literal('WAITING_USER'))`
  - `ExtensionSendQueueItemSchema = { id, status, mode, priority: 0|1, position: int|null, attempts: int, resultCode: string|null, createdAt, updatedAt }`
  - `ExtensionSendQueueSchema = { paused: boolean, pauseReason: string|null, items: ExtensionSendQueueItemSchema[] }`
  - Tipos exportados: `SendTiming`, `SendTimingOverride`, `ExtensionSendQueueItem`, `ExtensionSendQueue`

- [ ] **Step 1: Write failing tests** — `resolveSendTiming merges override over settings`; `rejects autoCountdownMs 30001 and executionTimeoutMs 19999`; `accepts queueMaxWaitMs null`; `ExtensionSendStepSchema accepts DRAFTED`; `command requires timing and appendToDraft`.
- [ ] **Step 2:** `pnpm vitest run packages/shared/test/extension-send-timing.test.ts` → FAIL (exports ausentes).
- [ ] **Step 3:** Implementar no arquivo de contratos; ajustar fixtures existentes que constroem `ExtensionSendCommand` adicionando `timing: DEFAULT_SEND_TIMING, appendToDraft: false`.
- [ ] **Step 4:** `pnpm typecheck && pnpm vitest run packages/shared` → PASS.
- [ ] **Step 5:** Commit `feat(shared): contratos de fila e tempos de envio`.

### Task 2: Migration 017 e repositório de configurações

**Files:**
- Create: `packages/database/src/migrations/017-send-queue.sql`
- Modify: `packages/database/src/migrations.ts` (registrar versão 17 `send-queue`)
- Create: `packages/database/src/repositories/send-settings.ts`
- Modify: `packages/database/src/repositories/outbox.ts` (`OutboxStatusSchema` + `'WAITING_WHATSAPP','DRAFTED'`)
- Modify: `packages/database/src/index.ts` (export)
- Test: `packages/database/test/send-settings.test.ts` (criar), `packages/database/test/database.test.ts` (versão 17)

**Interfaces:**
- Migration:
  - `CREATE TABLE wa_send_settings(singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1), timing_json TEXT NOT NULL, updated_at TEXT NOT NULL)`
  - `CREATE TABLE wa_send_queue_state(singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1), paused INTEGER NOT NULL DEFAULT 0, pause_reason TEXT, paused_at TEXT)`
  - `ALTER TABLE wa_outbox ADD COLUMN priority INTEGER NOT NULL DEFAULT 0 CHECK(priority IN (0,1))`
  - `ALTER TABLE wa_outbox ADD COLUMN target_key TEXT`
  - `ALTER TABLE wa_outbox ADD COLUMN timing_json TEXT`
  - `UPDATE wa_outbox SET status='QUEUED' WHERE kind='extension-send' AND status='REQUESTED'` (+ linha em `wa_outbox_history` com reason `MIGRATED_TO_QUEUED`)
  - `CREATE INDEX wa_outbox_send_queue_idx ON wa_outbox(kind,status,priority DESC,created_at,id)`
- Produces: `class SendSettingsRepository { constructor(db, now?); get(): SendTiming; update(input: SendTimingOverride): SendTiming }` — `get` devolve `DEFAULT_SEND_TIMING` se não houver linha; `update` mescla, valida com `SendTimingSchema` e grava.

- [ ] **Step 1: Failing tests** — `get returns defaults on empty db`; `update persists merged values`; `update rejects out-of-range`; `migration converts pending REQUESTED extension-send to QUEUED and leaves kind=send untouched`; `schema version is 17`.
- [ ] **Step 2:** `pnpm vitest run packages/database/test/send-settings.test.ts packages/database/test/database.test.ts` → FAIL.
- [ ] **Step 3:** Implementar migration e repositório (estilo do `outbox.ts`/`maintenance.ts`).
- [ ] **Step 4:** Mesmos testes → PASS; `pnpm test` → PASS (ajustar testes que esperam `REQUESTED` em extension-send).
- [ ] **Step 5:** Commit `feat(database): schema 17 com configurações e fila de envio`.

### Task 3: Fila no `ExtensionSendRepository`

**Files:**
- Modify: `packages/database/src/repositories/extension-send.ts`
- Test: `packages/database/test/extension-send.test.ts`, `packages/database/test/send-to-number.test.ts`

**Interfaces:**
- Consumes: `SendSettingsRepository`, `resolveSendTiming`, schemas da Task 1.
- Produces (métodos públicos novos/alterados):
  - `create*` gravam `status='QUEUED'`, `priority` (1 se `mode==='AUTO'` e countdown resolvido = 0), `target_key` e `timing_json` (tempo resolvido no momento da criação).
  - `target_key`: `conv:<conversationId>` quando houver conversa confirmada; senão `phone:<recipientPhone normalizado>`. Após prova de destinatário em `progress`, atualizar para `conv:<resolved.conversationId>`.
  - `queue(): ExtensionSendQueue` — itens não terminais ordenados por `priority DESC, created_at, id`, `position` 1..n para `QUEUED`/`WAITING_WHATSAPP`, `null` para em execução.
  - `status(id: string): ExtensionSendQueueItem` (lança `COMMAND_NOT_FOUND`).
  - `recover()` reescrito:
    - lease expirado em `CLAIMED|TARGET_VERIFIED|COMPOSED|WAITING_AUTO_SEND` → `QUEUED` (`EXTENSION_INTERRUPTED_REQUEUED`), limpa lease, libera interface lease, pausa a fila (`pause_reason='INTERRUPTED'`).
    - `SENDING` expirado → `UNKNOWN` (como hoje).
    - Expiração: `QUEUED|WAITING_WHATSAPP` com `queueMaxWaitMs` não nulo e `created_at + queueMaxWaitMs <= now` → `FAILED/REQUEST_EXPIRED`. Remove o corte fixo de 300000 ms.
  - `poll()`:
    - Se `activeCommand` ausente e existir item não terminal com `lease_owner LIKE '<extensionInstanceId>:%'` → tratar como interrompido (mesma transição de `recover`) imediatamente.
    - Se `!input.ready || input.reason ∈ {NO_WHATSAPP_TAB, CONTENT_UNREACHABLE, CONTENT_OUTDATED, NO_MONITORED_CONTEXT}` → todos `QUEUED` → `WAITING_WHATSAPP`.
    - Se `input.ready && input.allowClaim && reason==='READY'` → todos `WAITING_WHATSAPP` → `QUEUED` e despausa a fila.
    - Fila pausada → não reivindica.
    - Seleção: `status='QUEUED'`, mesma regra de alvo atual, `ORDER BY priority DESC, created_at, id`.
    - Lease de interface e `lease_until` = `timing.executionTimeoutMs`.
    - Comando inclui `timing` e `appendToDraft` = existe outro `extension-send` com mesmo `target_key`, status `DRAFTED`, criado antes.
  - `progress()`:
    - `DRAFTED` aceito a partir de `CLAIMED` só em `SUPERVISED`, exige a mesma prova de destinatário hoje exigida para `WAITING_USER` quando `locateByPhone`; é terminal e libera o lease.
    - `WAITING_AUTO_SEND` usa `timing.autoCountdownMs` para `nextAttemptAt`.
    - `WAITING_USER` deixa de ser aceito em novos pedidos (`SEND_STATE_CONFLICT`).
  - `cancel()` aceita também `QUEUED` e `WAITING_WHATSAPP`.
  - `terminal` passa a incluir `'DRAFTED'`; `diagnostics().queue` exclui `DRAFTED`.

- [ ] **Step 1: Failing tests** (nomes e asserções):
  - `serves three requests in creation order` — cria A,B,C; ciclo poll→progress terminal; status finais e ordem A,B,C.
  - `priority request jumps ahead of waiting ones but not the running one` — A em execução, B normal, C AUTO countdown 0 → próximo claim = C.
  - `supervised ends DRAFTED and frees the queue` — status `DRAFTED`, lease liberado, próximo claim possível.
  - `appendToDraft true only when same target has earlier DRAFTED`.
  - `requeue keeps original position and pauses queue` — expira lease de `COMPOSED` → `QUEUED`, `attempt_count` 1→ claim de novo exige poll `READY` antes.
  - `orphan from same instance requeued on poll without activeCommand`.
  - `SENDING lease expiry ends UNKNOWN and is never requeued`.
  - `no WhatsApp marks queue WAITING_WHATSAPP and READY restores QUEUED`.
  - `queue max wait counts from created_at; null never expires` (avançar relógio 25 h).
  - `cancel allowed in QUEUED, WAITING_WHATSAPP, WAITING_AUTO_SEND; rejected in SENDING`.
  - `execution lease uses configured executionTimeoutMs`.
  - `queue() reports positions and omits message text`.
- [ ] **Step 2:** `pnpm vitest run packages/database/test/extension-send.test.ts` → FAIL.
- [ ] **Step 3:** Implementar; atualizar `send-to-number.test.ts` para `QUEUED`.
- [ ] **Step 4:** `pnpm vitest run packages/database` → PASS.
- [ ] **Step 5:** Commit `feat(database): fila de envio com prioridade, requeue e pausa`.

### Task 4: Rotas da Local API, gestão e MCP

**Files:**
- Modify: `apps/local-api/src/services/api-service.ts`, `apps/local-api/src/app.ts`
- Modify: `packages/shared/src/operations.ts` (`ManagementRequestSchema` + `managementRoute`)
- Modify: `packages/mcp-server/src/server.ts`
- Test: `apps/local-api/test/api.test.ts`, `packages/mcp-server/test/mcp-server.test.ts`, `packages/mcp-server/test/permissions.test.ts`

**Interfaces:**
- Rotas (prefixo `/api`, autenticadas como as demais):
  - `GET /extension/outbox/queue` → `ExtensionSendQueue`
  - `GET /extension/outbox/:id` → `ExtensionSendQueueItem`
  - `GET /extension/send-settings` → `SendTiming`
  - `PATCH /extension/send-settings` body `SendTimingOverride` → `SendTiming`
- Service: `extensionSendQueue()`, `extensionSendStatus(id)`, `sendSettings()`, `updateSendSettings(input)`.
- Management ops: `SEND_QUEUE` (GET queue), `SEND_STATUS` `{id}`, `SEND_SETTINGS_GET`, `SEND_SETTINGS_UPDATE` `{input}` (PATCH), `SEND_CANCEL` `{id}` (POST `/api/extension/outbox/:id/cancel`).
- MCP:
  - Ferramentas de envio aceitam `timing` opcional; descrições trocam "five cancelable seconds" por "configured cancelable countdown (0 s gives priority)" e "SUPERVISED prepares a draft and finishes as DRAFTED".
  - Nova `whatsapp_get_send_queue` (readOnly) → `/api/extension/outbox/queue`; nova `whatsapp_get_send_status` `{id}` → `/api/extension/outbox/:id`.
  - Configurações não são alteráveis pelo MCP (somente painel). *(decisão do agente: o design diz "editável no painel")*

- [ ] **Step 1: Failing tests** — API: `GET queue returns ordered items`; `PATCH settings rejects 400 out of range`; `create with timing override out of range returns 400`; `GET status 404 for unknown id`. MCP: `send tools forward timing`; `get_send_queue is read-only and available without send opt-in`.
- [ ] **Step 2:** `pnpm vitest run apps/local-api packages/mcp-server` → FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Mesmo comando → PASS; `pnpm test:integration` → PASS.
- [ ] **Step 5:** Commit `feat(api,mcp): consulta de fila, status por pedido e configurações de tempo`.

## Etapa 2 — Estado inicial, modo rascunho e junção

### Task 5: Normalização e retorno ao estado inicial na busca

**Files:**
- Modify: `apps/chrome-extension/src/commands/phone-search.ts`
- Test: `apps/chrome-extension/test/e2e/phone-search.spec.ts`, `apps/chrome-extension/test/e2e/search-results.spec.ts`

**Interfaces:**
- Produces:
  - `PhoneSearch.normalize(): Promise<void>` — limpa busca da barra lateral, fecha gaveta "Nova conversa" (limpando seu campo) e drawer de perfil. Idempotente.
  - `PhoneSearch.resetAfterVerify(): Promise<void>` — chama `normalize()` mantendo a conversa alvo aberta; usado logo após `confirmAndClose`.
  - Remove as falhas `SEARCH_HAS_INPUT` e `NEW_CHAT_OPEN` (passam a ser normalizadas). `COMPOSER_HAS_DRAFT` sai da busca (tratado na Task 7).
  - `release()` vira alias de `normalize()` sem as condições atuais.

- [ ] **Step 1: Failing e2e** — `normalizes leftover search text and open new-chat drawer before searching`; `after verification search box is empty and drawers closed while target chat stays open`; `fallback via new-chat drawer leaves drawer closed and input empty`.
- [ ] **Step 2:** `pnpm --filter @wai-bridge/chrome-extension test:e2e -- phone-search search-results` → FAIL.
- [ ] **Step 3:** Implementar no `phone-search.ts` usando os seletores já existentes.
- [ ] **Step 4:** Mesmo comando → PASS.
- [ ] **Step 5:** Commit `feat(extension): normalizar busca e voltar ao estado inicial após validar contato`.

### Task 6: Supervisionado termina em `DRAFTED`

**Files:**
- Modify: `apps/chrome-extension/src/commands/visible-send.ts`
- Modify: `apps/chrome-extension/src/background/send-bridge.ts` (aceitar `DRAFTED` como terminal)
- Test: `apps/chrome-extension/test/e2e/visible-send.spec.ts`, `apps/chrome-extension/test/e2e/content-send-protocol.spec.ts`, `apps/chrome-extension/test/unit/send-bridge.test.ts`

**Interfaces:**
- Consumes: `command.timing`, `command.appendToDraft`, `PhoneSearch.resetAfterVerify()`.
- Produces: SUPERVISED → `normalize` → localizar/validar → `resetAfterVerify` → preparar campo (Task 7) → revalidar → `progress('DRAFTED','DRAFT_READY')` → fim. Remover `waitForManualSend` e interceptação de clique/Enter. AUTO usa `timing.autoCountdownMs` na contagem e `timing.sendVerifyMs` na conferência.

- [ ] **Step 1: Failing tests** — e2e `supervised leaves text in composer, target chat open, reports DRAFTED without user click`; `auto with countdown 0 sends immediately and reports SENT`; `auto uses configured verify timeout`; unit `bridge releases active job on DRAFTED and polls next`.
- [ ] **Step 2:** `pnpm --filter @wai-bridge/chrome-extension test` → FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Mesmo comando → PASS.
- [ ] **Step 5:** Commit `feat(extension): modo supervisionado entrega rascunho pronto e libera a fila`.

### Task 7: Preparação do campo com junção de rascunho

**Files:**
- Modify: `apps/chrome-extension/src/commands/visible-send.ts`
- Test: `apps/chrome-extension/test/e2e/visible-send.spec.ts`

**Interfaces:**
- Produces: `prepareComposer(text: string, appendToDraft: boolean): Promise<void>` em `VisibleSend` (privado), executado só depois que a conversa alvo está aberta e validada:
  - `appendToDraft && composer não vazio` → posiciona cursor no fim e insere quebra de linha + `text`, preservando o conteúdo existente (inclusive edições do usuário).
  - `appendToDraft && composer já termina com text` → não insere de novo (idempotência após requeue).
  - Caso contrário → seleciona tudo, apaga e insere `text`.

- [ ] **Step 1: Failing e2e** — `second supervised request to same target appends on new line`; `user-edited draft is preserved and new text appended at end`; `foreign text in target composer is erased when no earlier DRAFTED`; `requeued append does not duplicate text`; `composer of a different chat is never touched`.
- [ ] **Step 2:** `pnpm --filter @wai-bridge/chrome-extension test:e2e -- visible-send` → FAIL.
- [ ] **Step 3:** Implementar (quebra de linha via `insertLineBreak`/Shift+Enter no simulador; escolha do construtor).
- [ ] **Step 4:** Mesmo comando → PASS.
- [ ] **Step 5:** Commit `feat(extension): junção de rascunho no mesmo contato`.

## Etapa 3 — Disponibilidade e configurador

### Task 8: Despertador e recuperação no service worker

**Files:**
- Modify: `apps/chrome-extension/manifest.json` (permissão `"alarms"`)
- Modify: `apps/chrome-extension/src/background/service-worker.ts`
- Modify: `apps/chrome-extension/src/background/send-bridge.ts`
- Test: `apps/chrome-extension/test/unit/send-bridge.test.ts`, `apps/chrome-extension/test/e2e/runtime-invalidation.spec.ts`

**Interfaces:**
- Produces:
  - Alarme `wai-send-keepalive` com `periodInMinutes: 0.5`, criado em `onInstalled` e `onStartup` (idempotente); `chrome.alarms.onAlarm` → garante porta nativa conectada e dispara `sendBridge.poll()`.
  - Ao perder o job da página (aba recarregada/conteúdo inacessível), `SendBridge` descarta o `active` local e faz poll sem `activeCommand` (a API requeue via Task 3).
  - Reason enviado no poll reflete `NO_WHATSAPP_TAB`/`CONTENT_UNREACHABLE` quando aplicável (já existente; garantir que é enviado mesmo sem aba).

- [ ] **Step 1: Failing tests** — unit `alarm tick reconnects port and polls`; `tab reload during COMPOSED drops active and next poll omits activeCommand`; e2e `reload mid-request requeues and request completes after READY`.
- [ ] **Step 2:** `pnpm --filter @wai-bridge/chrome-extension test` → FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Mesmo comando → PASS.
- [ ] **Step 5:** Commit `feat(extension): despertador do Chrome e recuperação de pedidos interrompidos`.

### Task 9: Painel — configurador de tempos e fila

**Files:**
- Modify: `apps/chrome-extension/src/dashboard/dashboard.html`, `dashboard.ts`, `dashboard.css`
- Test: `apps/chrome-extension/test/e2e/dashboard.spec.ts`, `apps/chrome-extension/test/unit/management-bridge.test.ts`

**Interfaces:**
- Consumes: management ops `SEND_QUEUE`, `SEND_SETTINGS_GET`, `SEND_SETTINGS_UPDATE`, `SEND_CANCEL` (Task 4).
- Produces: seção "Envios" com
  - formulário de 4 tempos em segundos/minutos, faixas da Global Constraints como `min`/`max`, opção "sem limite" para espera na fila, botão salvar e restaurar padrão; erro de validação exibido por campo;
  - lista da fila (posição, modo, status, tentativas, motivo) atualizada a cada 3 s enquanto visível, com botão cancelar nos status canceláveis; indicador "Fila pausada" com motivo. Sem texto de mensagem, telefone ou nome.

- [ ] **Step 1: Failing e2e** — `saves timing and reloads persisted values`; `rejects out-of-range input without request`; `shows queue positions, paused banner and cancels a queued item`.
- [ ] **Step 2:** `pnpm --filter @wai-bridge/chrome-extension test:e2e -- dashboard` → FAIL.
- [ ] **Step 3:** Implementar seguindo o padrão das seções existentes.
- [ ] **Step 4:** Mesmo comando → PASS.
- [ ] **Step 5:** Commit `feat(extension): configurador de tempos e fila no painel`.

### Task 10: Documentação, ADR e verificação final

**Files:**
- Create: `.ai/decisions/0024-continuous-extension-send-queue.md`; Modify: `.ai/decisions/README.md`
- Modify: `.ai/rules/business-rules.md` (SUPERVISED = rascunho; fila; junção), `.ai/context/current-state.md`, `README.md` (se citar "cinco segundos" ou espera manual)

- [ ] **Step 1:** Escrever ADR 0024 (contexto, decisão = design aprovado, alternativas B/C, consequências: perda do rastreio de envio manual, risco de pausa indefinida por pedido que derruba a aba).
- [ ] **Step 2:** Verificação completa: `pnpm build && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration && pnpm test:extension:e2e` → todos exit 0; registrar contagens reais no `current-state.md`.
- [ ] **Step 3:** Matriz de aceitação: para cada critério 1–11 do design, citar o teste que o cobre e o resultado observado.
- [ ] **Step 4:** Commit `docs: ADR 0024 e estado verificado da fila de envio`.

## Mapa critério → tarefa

| Critério (design §13) | Tarefa / teste |
|---|---|
| 1 ordem e status final | T3 `serves three requests in creation order` |
| 2 DRAFTED sem interação | T3, T6 `supervised leaves text…` |
| 3 busca vazia e gavetas fechadas | T5 `after verification…` |
| 4 tela suja não falha | T5 `normalizes leftover…`, T7 `foreign text…` |
| 5 junção de rascunho | T7 `second supervised request…` |
| 6 WAITING_WHATSAPP | T3 `no WhatsApp marks…` |
| 7 reload requeue / UNKNOWN | T3, T8 `reload mid-request…` |
| 8 tempos persistidos e validados | T2, T4, T9 |
| 9 suítes passam | T10 Step 2 |
| 10 rascunho editado preservado | T7 `user-edited draft…` |
| 11 prioridade contagem 0 | T3 `priority request jumps ahead…` |
