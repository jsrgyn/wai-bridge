# Máquinas de estado

Cada transição é comando explícito da API, validado e auditado em transação. Persistir evento/status antes de notificação. Repetições com mesma chave idempotente retornam resultado original. Transições inválidas retornam erro estruturado `CONFLICT` sem mutação.

## Captura

`DETECTED → CAPTURED | PENDING | FAILED`; `PENDING → CAPTURED | FAILED`. DETECTED é observação acessível, CAPTURED é conteúdo/metadados persistidos, PENDING é conteúdo incompleto/aguardando recurso e FAILED é falha conhecida. Estado não representa badge visual nem prova de cobertura.

## Leitura pela IA

Cada consumidor mantém estado independente por `(messageId, consumerId)` em `wa_ai_consumer_message_state`: `UNREAD → CLAIMED → READ`; falha muda `CLAIMED → FAILED`, e retry pode reivindicar `FAILED` de novo. Claim grava token e lease; lease expirado pode ser retomado por novo claim/token. Somente ACK explícito do consumidor com token vigente move a `READ`. GET não altera estado. Mensagens sem estado do consumidor são elegíveis para recovery e aparecem como `UNREAD` em consultas filtradas por esse consumidor. A tabela legada `wa_ai_message_state` permanece para compatibilidade.

## Envio

Estados definidos: `REQUESTED`, `QUEUED`, `CLAIMED`, `TARGET_VERIFIED`, `COMPOSED`, `WAITING_AUTO_SEND`, `WAITING_USER`, `SENDING`, `SENT`, `UNKNOWN`, `FAILED`, `CANCELLED`.

Transições planejadas:

- comum: `REQUESTED → QUEUED → CLAIMED → TARGET_VERIFIED → COMPOSED`.
- SUPERVISED: `COMPOSED → WAITING_USER → SENT | UNKNOWN | FAILED | CANCELLED`.
- AUTO: `COMPOSED → WAITING_AUTO_SEND → SENDING → SENT | UNKNOWN | FAILED`; `WAITING_AUTO_SEND → CANCELLED` permitido.
- `UNKNOWN` é terminal para envio automático; resolução manual pode anexar fato/auditoria, mas não dispara reenvio como efeito colateral.
- `FAILED` e `CANCELLED` não retomam com a mesma operação; novo intento usa novo command ID e chave, com confirmação explícita se houver risco de envio anterior.

Não especificadas ainda: retry/reclaim de `QUEUED/CLAIMED`, cancelamento após SENDING, política de falha após restart e condição objetiva de SENT. Implementação bloqueada até resolver.

## Estado de captura versus leitura

Captura `CAPTURED` não altera indicador/read state do WhatsApp nem IA; mensagem pode ser consultada enquanto `UNREAD`. São dimensões independentes.
