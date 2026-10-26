# Robustez do envio após implantação parcial — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Um pedido nunca mais fica preso em silêncio quando API, agente macOS e extensão estão em versões diferentes; o pedido que não chega à extensão volta à fila; painel e MCP explicam a incompatibilidade; existe um reinício seguro após atualizar.

**Architecture:** Versão de protocolo de envio explícita (3) negociada no poll; o agente macOS distingue "API indisponível" de "contrato incompatível"; a API registra o aceite do comando pela extensão e devolve à fila pedidos `CLAIMED` sem aceite; painel/MCP mostram compatibilidade; script de reinício valida a versão após subir.

**Tech Stack:** TypeScript strict, Zod 4, better-sqlite3, Fastify, Chrome MV3, Vitest, Playwright, bash.

**Spec:** `.ai/plans/2026-10-24-send-stuck-claimed-fix-plan.md` (diagnóstico e tarefas aprovadas pelo usuário).

## Global Constraints

- Local API é a única dona do SQLite; migration aditiva `018-send-accept.sql` (schema 18).
- Contratos em Zod em `packages/shared`; TypeScript strict.
- `SEND_PROTOCOL_VERSION = 3` exportado de `packages/shared/src/extension-send.ts`; `ExtensionSendPollSchema.protocolVersion` passa a aceitar `2 | 3`.
- Tempo sem aceite antes de devolver à fila: `SEND_ACCEPT_TIMEOUT_MS = 20000` (constante em shared).
- Só pedidos antes de `SENDING` podem voltar à fila; `UNKNOWN` nunca é reenviado.
- Nunca envio real em teste; dados sintéticos (`+5500000000xx`).
- Logs, flow logs e respostas de status sem texto de mensagem, telefone ou nome.
- Antes de commitar: `pnpm build && pnpm typecheck && pnpm lint && pnpm test`; `pnpm test:integration` quando tocar API/host.

## Review Focus

1. API nova recebe poll de extensão antiga (`protocolVersion` 2 ou ausente) → nenhum claim; status do bridge mostra `CLIENT_OUTDATED` (Task 1).
2. API antiga devolve comando sem `timing` → host não derruba o stream e não marca `API_UNAVAILABLE`; responde `API_OUTDATED` e registra flow log com o `traceId` lido do JSON bruto (Task 1).
3. Extensão aceita o comando mas demora a dar progresso (busca lenta) → não é devolvido à fila, pois o aceite foi registrado (Task 2).
4. Aceite chega depois do prazo de 20 s, quando o pedido já voltou à fila → API responde `SEND_LEASE_MISMATCH`, extensão aborta sem compor (Task 2).
5. Painel com API antiga (404 nas operações de envio) → mensagem "API local desatualizada", sem quebrar as demais seções (Task 3).

---

### Task 1: Protocolo 3 e contrato incompatível visível

**Files:**
- Modify: `packages/shared/src/extension-send.ts`, `packages/database/src/repositories/extension-send.ts`, `apps/mac-agent/src/api-client.ts`, `apps/mac-agent/src/host.ts`, `apps/chrome-extension/src/background/send-bridge.ts`
- Test: `packages/database/test/extension-send.test.ts`, `apps/mac-agent/test/native-host.test.ts`, `apps/chrome-extension/test/unit/send-bridge.test.ts`, `tests/integration/extension-send-flow.test.ts`

**Interfaces:**
- Produces:
  - `export const SEND_PROTOCOL_VERSION = 3 as const;` e `SEND_ACCEPT_TIMEOUT_MS = 20000`.
  - `ExtensionSendPollSchema.protocolVersion: z.union([z.literal(2), z.literal(3)]).optional()`.
  - `SendBridgeReasonSchema` ganha `'API_OUTDATED'` e `'CLIENT_OUTDATED'`.
  - `ExtensionSendPollResultSchema` ganha `reason?: 'CLIENT_OUTDATED'`.
  - Repositório `poll()`: se `input.protocolVersion !== 3` → não reivindica, retorna `{ command: null, reason: 'CLIENT_OUTDATED' }` e grava `reason: 'CLIENT_OUTDATED'` no heartbeat do bridge.
  - Extensão envia `protocolVersion: SEND_PROTOCOL_VERSION`.
  - Host: no `SEND_POLL`, falha de validação do resultado da API (ZodError ou 400 de schema) → responde `ERROR` com `code: 'API_OUTDATED'` (não `API_UNAVAILABLE`); se o JSON bruto tiver `command.id`/`command.traceId`, registra flow log `NATIVE_HOST / SEND_CLAIMED / FAILED / API_CONTRACT_MISMATCH` com esse trace. O stream continua aberto.
  - `SendBridge`: ao receber `API_OUTDATED`, mantém `allowClaim` e reporta `reason: 'API_OUTDATED'` no próximo poll/diagnóstico; ao receber `reason: 'CLIENT_OUTDATED'` no resultado, reporta esse motivo.

- [ ] **Step 1: Failing tests** — DB: `poll with protocolVersion 2 never claims and reports CLIENT_OUTDATED`; host: `poll result missing timing answers API_OUTDATED and logs API_CONTRACT_MISMATCH with trace`, `stream stays usable after API_OUTDATED`; extension unit: `bridge surfaces API_OUTDATED reason`; integração: fluxo atual continua passando com protocolo 3.
- [ ] **Step 2:** rodar os testes → FAIL.
- [ ] **Step 3:** implementar.
- [ ] **Step 4:** `pnpm build && pnpm test && pnpm test:integration` e unit da extensão → PASS.
- [ ] **Step 5:** Commit `fix(send): protocolo 3 e incompatibilidade de contrato visível`.

### Task 2: Aceite do comando e devolução à fila sem aceite

**Files:**
- Create: `packages/database/src/migrations/018-send-accept.sql`; Modify: `packages/database/src/migrations.ts`
- Modify: `packages/shared/src/extension-send.ts`, `packages/database/src/repositories/extension-send.ts`, `apps/chrome-extension/src/background/send-bridge.ts`
- Test: `packages/database/test/extension-send.test.ts`, `packages/database/test/database.test.ts` (versão 18), `apps/chrome-extension/test/unit/send-bridge.test.ts`, `tests/integration/extension-send-flow.test.ts`

**Interfaces:**
- Migration: `ALTER TABLE wa_outbox ADD COLUMN accepted_at TEXT;`
- `ExtensionSendStepSchema` ganha `'ACCEPTED'`.
- Repositório `progress()` com `ACCEPTED`: exige lease válido e status `CLAIMED`; grava `accepted_at` (idempotente), não muda status, não é terminal; flow log `SEND_ACCEPTED`.
- Repositório `recover()`: `CLAIMED` com `accepted_at IS NULL` e `updated_at + SEND_ACCEPT_TIMEOUT_MS <= now` → mesma transição de interrupção já existente (volta a `QUEUED`, limpa lease, libera interface lease, pausa a fila) com código `EXTENSION_NO_ACK`; adicionar `EXTENSION_NO_ACK` ao enum de flow log se necessário.
- Requeue limpa `accepted_at`.
- Extensão: depois do `acknowledgement.accepted` da aba, chama `progress({ step: 'ACCEPTED', code: 'ACCEPTED' })`; se a API responder `SEND_LEASE_MISMATCH`/conflito, envia cancelamento à aba (aborta o job local) sem compor.

- [ ] **Step 1: Failing tests** — `CLAIMED without ACCEPTED for 20001 ms is requeued with EXTENSION_NO_ACK and pauses`; `ACCEPTED keeps CLAIMED and prevents no-ack requeue`; `ACCEPTED after requeue is rejected`; `SENDING is never touched by no-ack recovery`; `schema version is 18`; unit extensão: `bridge reports ACCEPTED after tab acceptance` e `aborts local job when ACCEPTED is rejected`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** `pnpm build && pnpm test && pnpm test:integration`, unit da extensão e e2e `content-send-protocol` → PASS.
- [ ] **Step 5:** Commit `fix(send): aceite do comando e devolução à fila sem aceite`.

### Task 3: Diagnóstico de compatibilidade no status, painel e MCP

**Files:**
- Modify: `apps/local-api/src/services/api-service.ts`, `packages/database/src/repositories/extension-send.ts` (`diagnostics`), `packages/mcp-server/src/server.ts` (descrição de `whatsapp_status`), `apps/chrome-extension/src/dashboard/dashboard.ts`, `dashboard.html`
- Test: `apps/local-api/test/api.test.ts`, `packages/mcp-server/test/mcp-server.test.ts`, `apps/chrome-extension/test/e2e/dashboard.spec.ts`

**Interfaces:**
- `/api/status` ganha `sendProtocolVersion: 3` e `extension.compatible: boolean` (= bridge protocolo 3 e não `STALE`/`UNSEEN`), além do `schemaVersion` existente e do `build` do bridge.
- Painel: resposta `NOT_FOUND` em qualquer operação `SEND_*` → banner "API local desatualizada: reinicie o serviço (scripts/restart-local-services.sh)"; diagnóstico mostra schema, protocolo da API e build da extensão; motivo `API_OUTDATED`/`CLIENT_OUTDATED` exibido em português. As outras seções continuam funcionando.
- MCP `whatsapp_status`: descrição menciona `compatible` e a ação de reiniciar.

- [ ] **Step 1: Failing tests** — API: `status reports sendProtocolVersion and compatible false for protocol 2 bridge`; e2e painel: `404 on send ops shows outdated API banner and keeps other sections`; MCP: `status passes compatible through`.
- [ ] **Step 2–4:** FAIL → implementar → `pnpm build && pnpm test`, e2e dashboard → PASS.
- [ ] **Step 5:** Commit `feat(diagnostics): compatibilidade de versões no status, painel e MCP`.

### Task 4: Reinício seguro e documentação

**Files:**
- Create: `scripts/restart-local-services.sh`; Test: `tests/unit/restart-local-services.test.ts`
- Modify: `README.md`, `docs/operations/extension-sending.md`, `docs/operations/troubleshooting.md`, `.ai/context/current-state.md`; Create: `.ai/decisions/0025-send-protocol-version-and-accept.md`; Modify: `.ai/decisions/README.md`

**Interfaces:**
- `scripts/restart-local-services.sh [--check]`:
  - sem argumentos: `pnpm build`, backup consistente do banco via `sqlite3 ... "VACUUM INTO"` em arquivo `backup-<timestamp>.sqlite` (permissão 600) no diretório do banco, `launchctl kickstart -k gui/$UID/com.wai-bridge.local-api`, aguarda até 15 s o processo novo e confirma `MAX(version)` do schema igual ao número da última migration do repositório; imprime instrução para recarregar extensão/aba e reiniciar o cliente MCP.
  - `--check`: não altera nada; compara o início do processo da API com o horário do `apps/local-api/dist/main.js` e o schema do banco com a última migration; sai 1 com "reinício necessário" se divergente.
  - Caminho do banco: `WAI_BRIDGE_DB_PATH` se definida; senão o padrão em `~/Library/Application Support/WaiBridge/data/wai-bridge.sqlite`. Nunca lê tokens.
- Teste: executa o script com `--check` num diretório temporário com banco sintético e binários simulados por `PATH` (stubs de `launchctl`, `ps`), validando saída 1 quando o schema está atrás e 0 quando está igual.
- Docs: passo obrigatório "após atualizar, rode `scripts/restart-local-services.sh`"; troubleshooting de `CLAIMED` preso, `API_OUTDATED`, `CLIENT_OUTDATED`, `EXTENSION_NO_ACK`; ADR 0025.

- [ ] **Step 1:** teste do `--check` falhando. **Step 2:** implementar script. **Step 3:** docs e ADR. **Step 4:** verificação completa (`pnpm build`, lint, typecheck, test, test:integration, unit e e2e afetados da extensão) com resultados reais no `current-state.md`. **Step 5:** Commit `chore(ops): reinício seguro dos serviços locais e documentação`.
