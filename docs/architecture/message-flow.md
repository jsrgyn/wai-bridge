# Fluxo de mensagens e captura

## Captura

`IDLE → OBSERVING → DETECTED → CAPTURED | PENDING | FAILED` é estado de captura/observação, distinto de leitura IA e de indicador visual de novidade. A extensão observa somente novos nós/mudanças acessíveis depois que o monitor inicia; elementos já visíveis no primeiro snapshot não são importados. Mensagem nova em conversa previamente aberta pode ser observada. Duplicatas usam chave estável local quando disponível e janela/session fallback sem alegar dedupe perfeito.

A observação identifica `conversationId` interno e, quando possível, contato/grupo externo com `source`; em grupo, conversation e sender são chaves separadas. Nome visível é atributo descritivo, nunca chave única. Se identidade/texto/mídia forem parciais, persistir availability/status e nunca preencher com suposição. Captura e leitura do WhatsApp não são inferidas de badge/bolinha/unread indicator.

## Consulta

Consultas de mensagens recentes ordenam por sequência/cursor e timestamp; filtragem por `AIMessageState` é opcional. GET é read-only: não claim, não altera `UNREAD`, não marca `READ`. Cursor é opaco, vinculado a filtros/ordenação, com limite de página definido pelo servidor.

## IA

Consumidor autorizado faz claim condicional/idempotente; processamento ocorre fora da transação. Somente `POST ack` explícito com message ID, versão/claim token e idempotency key move estado para `READ`. Falha controlada move para `FAILED`; retry/reclaim precisa de regra explícita e auditoria. Estado inicial de mensagens elegíveis é `UNREAD`; direção OUTBOUND pode ser excluída de fila de IA por filtro contratual, a decidir no contrato de negócio.
