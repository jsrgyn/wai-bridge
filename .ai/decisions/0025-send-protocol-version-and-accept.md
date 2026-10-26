# ADR0025 — Versão do protocolo de envio, aceite do comando e reinício seguro

Data: 2026-10-25. Estado: Accepted.

Diagnóstico e plano: `.ai/plans/2026-10-24-send-stuck-claimed-fix-plan.md`; execução em `.ai/plans/2026-10-25-send-robustness-plan.md`. Relacionado: [ADR 0024](0024-continuous-extension-send-queue.md).

## Contexto

Após uma implantação parcial, a Local API gerenciada pelo launchd continuou executando o build anterior, com o banco no schema anterior, enquanto o agente macOS e a extensão já eram a versão nova. A API antiga reivindicava pedidos e devolvia comandos sem `timing` nem `appendToDraft`; o agente rejeitava o contrato novo em silêncio e o pedido ficava `CLAIMED` até o lease expirar (`EXTENSION_LEASE_EXPIRED`). O painel recebia 404 das rotas novas e exibia só `NOT_FOUND`.

## Decisão

- **Protocolo de envio versão 3** (`SEND_PROTOCOL_VERSION`). O poll informa `protocolVersion`; o claim exige 3. Versão diferente ou ausente recebe `command: null` e `reason: CLIENT_OUTDATED`, sem alterar o pedido. O schema do poll mantém `protocolVersion` opcional para tolerar clientes antigos (que são recusados no claim). Ausência é registrada como versão 1.
- **Falha visível de contrato.** Resposta da API que não cumpre o contrato do comando não é descartada: o agente responde `API_OUTDATED` à extensão e grava o flow log `NATIVE_HOST / FAILED / API_CONTRACT_MISMATCH`. O contrato não foi relaxado: falhar visivelmente é preferível a executar com tempos implícitos.
- **Aceite do comando.** A extensão reporta `ACCEPTED` ao receber o comando; a API o persiste (migration 018, schema 18) de forma idempotente dentro do mesmo lease, inclusive após etapas posteriores. `CLAIMED` sem `ACCEPTED` por `SEND_ACCEPT_TIMEOUT_MS` (20 s) volta a `QUEUED` com `EXTENSION_NO_ACK` e a fila é pausada até um poll READY. Só antes de `SENDING`: nunca há duplicação.
- **Diagnóstico.** `/api/status` expõe `sendProtocolVersion`, `schemaVersion` e `extension` (com `compatible`, `protocolVersion` e `build` do cliente); o painel mostra as versões lado a lado e o `whatsapp_status` do MCP traz `extension.compatible`. (O plano previa `apiBuild`; não foi implementado, a versão do protocolo e o schema bastam para detectar divergência.)
- **Reinício seguro.** `scripts/restart-local-services.sh`: sem argumentos, `pnpm build`, backup com `VACUUM INTO` (permissão 600, `integrity_check` = ok antes de prosseguir; falha aborta), `launchctl kickstart -k gui/<uid>/com.wai-bridge.local-api`, espera de até 15 s pelo novo processo e confirmação de `MAX(version)` igual à última migration. `--check` não altera nada: sai 1 com "reinício necessário" se o processo da API iniciou antes de `apps/local-api/dist/main.js` ou o schema está atrás, ou se a API não está em execução. Não lê tokens. O passo "após atualizar, rode o script" é obrigatório na documentação.

## Alternativas consideradas

- **Aceitar comando sem `timing` na ponta:** rejeitada; executaria com tempos implícitos.
- **Reiniciar a API automaticamente pelo agente macOS:** rejeitada; dar ao agente poder sobre o ciclo de vida do serviço amplia a superfície sem necessidade.
- **Fixar `API_OUTDATED` no pedido:** inviável, pois a API antiga é a que não grava a causa.

## Consequências

- Uma implantação parcial produz erro visível (`CLIENT_OUTDATED`, `API_OUTDATED`, banner no painel) em vez de silêncio.
- Limite conhecido: `API_OUTDATED` só é visível nos logs do agente/extensão e no painel, não no status do pedido, e o pedido reivindicado pela API antiga permanece `CLAIMED` até o reinício. Um escopo por contexto de poll antigo pode permanecer até o próximo poll.
- Operadores precisam rodar o script após cada atualização; `--check` serve para verificação rotineira. O script não é executado automaticamente.
- Clientes MCP e a aba do WhatsApp Web ainda precisam ser recarregados manualmente.
