# Fluxo de eventos

1. Após ativação manual, a extensão observa apenas mudanças novas nos nós visíveis. `ConversationObserver` produz `DETECTED` para atividade sem conteúdo; `MessageObserver` produz `CAPTURED`, `PENDING` ou `FAILED` conforme o que consegue ler. Cada observação recebe UUID e timestamp UTC. Não há varredura histórica nem navegação automática.
2. O service worker valida a origem do content script e persiste uma fila local limitada a 100 observações antes de encaminhar pelo Native Messaging. O host valida o envelope e a sessão e chama a API REST autenticada.
3. A API, em transação SQLite, insere `wa_capture_observations` e o evento em `wa_events`. O mesmo `observationId`, `extensionInstanceId` e payload retorna o mesmo event ID; reutilizar o ID com outros dados causa conflito. Somente após commit a API responde ao host. A extensão remove o item da fila após `CAPTURE_RESULT`.
4. `message.captured`, `message.detected` ou `conversation.detected` identifica o tipo do evento. O payload do evento contém somente ID da observação, tipo e estado. O conteúdo completo requer consulta autenticada a `GET /api/observations/{id}`. `GET` não altera leitura pela IA.
5. O dispatcher lê eventos persistidos e notifica clientes por WebSocket. A notificação pode ser repetida ou perdida; o evento continua no SQLite. Consumidores deduplicam por event ID e recuperam lacunas pela API.

Falha antes do commit não anuncia evento. Falha após o commit e antes do ACK mantém a observação na fila para reenvio idempotente. A fila limitada pode saturar durante uma indisponibilidade longa; isso é reportado como erro e não implica captura completa. ACK de transporte não é ACK de leitura pela IA.

## Workers de entrega

`wa_event_delivery` representa a entrega de broadcast. Um claim com `BEGIN IMMEDIATE` grava owner/deadline e incrementa tentativas atomicamente. `wa_event_delivery_attempt` registra cada tentativa. Leases expirados são recuperados; erros transitórios usam backoff exponencial e falhas permanentes entram em DLQ lógica. WebSocket é apenas notificação e não é fonte da verdade.
