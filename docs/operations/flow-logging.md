# Diagnóstico do fluxo de eventos

A ferramenta MCP `whatsapp_get_flow_logs` consulta a trilha operacional persistida pela API no SQLite. Não é necessário procurar o evento em cada console separadamente.

## Como consultar

1. Recarregue WAI Bridge em `chrome://extensions` e depois o WhatsApp Web. Reconecte o MCP no cliente de IA para carregar a nova ferramenta.
2. Execute a operação habitual. As respostas MCP incluem `requestTraceId`; os pedidos de envio também retornam `traceId` e o ID do comando.
3. Peça: “Use wai-bridge para consultar os logs do comando <ID>” ou “consulte os logs do trace <traceId>”.
4. Para investigar uma falha, use o filtro `level: ERROR`. Para ver uma camada, use `component`. Comece sem filtros para não ocultar etapas relevantes.

Exemplo de argumentos (substitua o UUID pelo ID retornado):

```json
{ "resourceId": "00000000-0000-4000-8000-000000000001", "limit": 50 }
```

Também existem `traceId`, `component`, `level` e `beforeSequence`. O retorno traz a página mais recente em ordem de recebimento crescente; `nextBeforeSequence` permite buscar páginas anteriores. `commandStatus` informa o estado persistido do comando; `latestRecorded` é somente o último diagnóstico recebido. `resolvedTraceId` identifica a correlação canônica, inclusive em replay idempotente.

## Onde o evento passou

| Camada               | Exemplos de etapas                                                                      |
| -------------------- | --------------------------------------------------------------------------------------- |
| MCP                  | ferramenta iniciada/concluída, HTTP, consulta de captura                                |
| API                  | solicitação recebida, resposta, duração e erro                                          |
| SQLITE               | pedido gravado/reutilizado, claim, progresso, captura confirmada                        |
| NATIVE_HOST          | encaminhamento da captura, ACK, comando recebido, conexão                               |
| EXTENSION_BACKGROUND | captura enfileirada, ponte pronta/bloqueada, comando aceito                             |
| EXTENSION_CONTENT    | execução aceita no conteúdo da aba                                                      |
| WHATSAPP_UI          | mensagem observada, busca e conferência do destinatário, composição, espera, envio/erro |

Captura usa o UUID da observação como trace e recurso. Envio usa um trace propagado entre as camadas e o UUID do comando como recurso. Consulta posterior de mensagens registra `CAPTURE_READ`, com referência ao trace da consulta. Isso não altera o estado de leitura do WhatsApp.

`WHATSAPP_UI` descreve apenas fatos observáveis na interface acessível. Não oferece acesso aos servidores do WhatsApp nem comprova entrega ao destinatário. A ausência de uma etapa não prova que o efeito não aconteceu. `at` é o horário da origem; `receivedAt` e `sequence` representam recebimento pela API. Filas podem entregar registros fora da ordem causal.

## Privacidade, limites e operação

Eventos usam contrato Zod estrito com enums: IDs, camada, etapa, resultado, código, duração, modo/direção e build. Não aceitam texto de mensagem, nome, telefone, token, cabeçalhos, stack ou detalhes livres. Console da extensão e stderr MCP/native usam registros estruturados; stdout do MCP continua reservado ao protocolo.

Filas de diagnóstico são independentes das filas de negócio: até 200 eventos, lotes de 50, envio assíncrono. Falha de logging não autoriza repetir envio nem muda seu estado. A fila da extensão persiste em storage local; filas MCP/native são em memória. Sob indisponibilidade/limite pode haver perda de diagnóstico. Não há importação retroativa de logs nem histórico de mensagens.

SQLite schema11 adiciona `wa_flow_logs` e `wa_outbox.flow_trace_id`. Retenção: sete dias, máximo 20 mil registros, limpeza na gravação; consultas já ocultam expirados. Essa política não remove mensagens nem auditoria. A API é a única dona do SQLite. HTTP autenticado: `POST /api/diagnostics/logs` recebe `{events:[...]}`; `GET /api/diagnostics/logs` aceita os filtros acima. Ambos exigem o Bearer local existente; nunca publique esse token.
