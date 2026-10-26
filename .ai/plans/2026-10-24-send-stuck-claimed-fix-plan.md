# Correção: envios presos em CLAIMED e painel com NOT_FOUND

- Data: 2026-10-24
- Status: proposto, aguardando aprovação
- Relacionado: ADR 0024 (fila de envio contínua)

## 1. Sintomas observados

- Pedidos AUTO via MCP ficam em `CLAIMED` e, após cerca de 3 minutos, terminam `FAILED / EXTENSION_LEASE_EXPIRED`.
- O painel da extensão mostra apenas `NOT_FOUND` ao atualizar o diagnóstico.

## 2. Evidências (coletadas sem ler conteúdo de mensagens)

| Camada | Evidência |
|---|---|
| Processo da Local API | iniciado antes da integração da fila (dias antes) e nunca reiniciado; o `dist` foi recompilado depois |
| Banco | versão de schema 16 (a fila exige 17; a migration roda na inicialização da API) |
| Lease | 180 s fixos e expiração como `FAILED` — comportamento da versão antiga |
| Agente macOS e extensão | iniciados/compilados com os contratos novos |
| Flow logs do pedido | `SEND_REQUESTED` → `SEND_CLAIMED` no SQLite e, depois, nenhum evento de `NATIVE_HOST` nem de `EXTENSION` até `EXTENSION_LEASE_EXPIRED` |
| Teste de contrato | um comando no formato antigo é rejeitado pelo `ExtensionSendCommandSchema` novo (`timing` e `appendToDraft` ausentes) |

## 3. Causa raiz

Implantação parcial. A Local API em execução é a versão anterior e o agente macOS e a extensão são a versão nova:

1. A API antiga reivindica o pedido (`CLAIMED`) e devolve um comando sem `timing` nem `appendToDraft`.
2. O agente macOS valida a resposta com o contrato novo, a validação falha e o comando nunca chega à extensão.
3. A falha não é registrada no trace do pedido, por isso ele fica em silêncio até o lease expirar.
4. O painel chama as operações novas (`SEND_QUEUE`, `SEND_SETTINGS_GET`), que não existem na API antiga, e recebe 404, exibido como `NOT_FOUND`.

O texto "não há contato salvo" em uma das tentativas é outro caso: o MCP não encontrou o nome no catálogo local e corretamente não adivinhou o número. Não é defeito.

## 4. Correção imediata (operacional)

1. Fazer backup verificado pelo painel ou pela rotina de manutenção existente.
2. Reiniciar a Local API pelo launchd para carregar o código novo e aplicar a migration 17.
3. Recarregar a extensão e a aba do WhatsApp Web e reiniciar o cliente MCP.
4. Executar a verificação manual da seção 7.

## 5. Correções de robustez (código)

### Tarefa A — Compatibilidade de versão entre componentes
- A API passa a expor `apiBuild` e `schemaVersion` em `/api/status`. O agente macOS e a extensão enviam `clientBuild` e `protocolVersion` no poll (já existente).
- No poll, se a resposta da API não satisfizer o contrato do comando, o agente macOS:
  - não descarta o comando em silêncio;
  - responde à extensão com o motivo `API_OUTDATED` (novo valor em `SendBridgeReasonSchema`);
  - registra um flow log `NATIVE_HOST / FAILED / API_CONTRACT_MISMATCH` com o `traceId` do pedido, quando ele puder ser lido.
- A API passa a recusar o claim (devolve `command: null` com `reason: CLIENT_OUTDATED`) quando o poll indicar um protocolo incompatível, para nunca deixar um pedido em `CLAIMED` sem executor capaz.
- Testes:
  - agente macOS com comando sem `timing` → flow log `API_CONTRACT_MISMATCH`, sem lançar e sem derrubar o stream;
  - API com `protocolVersion` incompatível → nenhum claim, status do pedido inalterado.

### Tarefa B — Diagnóstico claro no painel e no MCP
- O painel trata 404 das operações de envio como "API local desatualizada: reinicie o serviço" e mostra as versões da API e da extensão lado a lado.
- `whatsapp_status` inclui `apiBuild`, `schemaVersion`, `bridge.build` e um campo `compatible: boolean`.
- Testes: e2e do painel com 404 simulado mostra a mensagem acionável; teste MCP com versões divergentes devolve `compatible: false`.

### Tarefa C — Reinício seguro após atualização
- Script `scripts/restart-local-services.sh`: faz build, backup, `launchctl kickstart -k` da API e confirmação de `/api/status` com a versão esperada. Não toca em credenciais nem em dados de mensagens.
- README e `docs/operations/extension-sending.md` ganham o passo "após atualizar, reinicie os serviços".
- Teste: execução do script em modo de verificação (`--check`), sem reiniciar nada, valida a detecção de versão divergente.

### Tarefa D — Pedido preso em CLAIMED sem progresso
- Se um pedido ficar `CLAIMED` sem nenhum progresso da extensão por mais de N segundos (padrão 20 s, fora da faixa de execução configurável), a API o devolve à fila com `EXTENSION_NO_ACK` e pausa a fila. Isso só vale antes de `SENDING`, então não há risco de envio duplicado.
- Testes:
  - repositório: `CLAIMED` sem ACK por 21 s → `QUEUED` com fila pausada;
  - repositório: `SENDING` nunca é afetado.
- A extensão passa a reportar um progresso `ACCEPTED` ao receber o comando, para distinguir "não chegou" de "está executando". Esse passo já existe no protocolo de conteúdo e passa a ser persistido.

## 6. Fora de escopo

- Busca de contato por nome no MCP: o comportamento atual (não adivinhar número) está correto.
- Alterar o formato do contrato para aceitar comandos sem `timing`: preferimos falhar visivelmente a executar com tempos implícitos.

## 7. Verificação

Automática, em cada tarefa:
- `pnpm build && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration`
- testes unitários da extensão e os specs e2e afetados (dashboard, content-send-protocol, runtime-invalidation).

Manual, após a correção imediata, com o próprio número do usuário e texto sintético:
1. Painel: seção Envios carrega tempos e fila; diagnóstico sem `NOT_FOUND`.
2. `whatsapp_status`: schema 17, versões compatíveis, bridge `READY`.
3. Um pedido SUPERVISED → `DRAFTED`, rascunho no campo, busca vazia.
4. Um pedido AUTO com contagem padrão → `SENT` com evidência.
5. Dois pedidos seguidos → atendidos em ordem.
6. Conferir os pontos não verificados no WhatsApp real: fechamento da gaveta "Nova conversa" e quebra de linha na junção de rascunhos.

## 8. Ordem sugerida

Correção imediata (seção 4) → A → D → B → C. A e D eliminam o "preso em silêncio"; B e C evitam que a implantação parcial volte a acontecer.
