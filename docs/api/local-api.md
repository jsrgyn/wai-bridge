# Local API — comportamento atual

A API fornece os endpoints listados em `openapi.yaml`. A única rota pública é `GET /health`; o restante exige um bearer token local configurado via `WAI_BRIDGE_API_TOKEN` (mínimo de 32 caracteres). Atualmente o token representa um único principal local de acesso total; escopos distintos por endpoint ainda não existem. A API de produção liga-se somente a `127.0.0.1`.

Todas queries e bodies são validados por Zod, paginação aceita `limit` entre 1 e 100 e cursor opaco. Mensagens globais são ordenadas por `observedAt,id`; consultas por conversa usam sequência local. `GET` nunca altera estado IA; claim/ACK são operações autenticadas e ACK válido exige consumidor e claim token coincidentes.

`GET /api/media/:id` fornece metadados sem caminho local nem bytes. `packages/media` implementa armazenamento local, mas ainda não foi composto com a API nem expõe upload/download. O AI Gateway não carrega bytes por caminho; uma integração deve fornecer bytes explicitamente e habilitar provider externo para transferir mídia.

AI reading tem endpoints autenticados por consumidor: `POST /api/ai/consumer-claims` cria lease (1s–24h; padrão 60s), `POST /api/ai/consumer-ack` confirma explicitamente `READ`, `POST /api/ai/consumer-fail` registra falha e `GET /api/ai/consumers/{consumerId}/recoverable` recupera mensagens UNREAD/FAILED ou claims expirados. Estado é persistido em `wa_ai_consumer_message_state` por mensagem e consumidor. A query `GET /api/messages?consumerId=...&aiState=...` lê esse estado sem mutação. A tabela legada de estado global e endpoints `/ai/claims`/`/ai/ack` permanecem para compatibilidade.

`POST /api/outbox` persiste comando idempotente em `REQUESTED`; o dispatcher avança comandos SUPERVISED até `WAITING_USER`. O runtime usa verificador AUTO que nega autorização e executor simulado; não existe envio real. `POST /api/outbox/:id/cancel` cancela antes de `SENDING` e interrompe espera automática; `POST /api/outbox/:id/result` registra resultado manual, exigindo `evidenceRef` para `SENT`. UNKNOWN é terminal e não é repetido.

Logs Pino redigem URL, body, bearer e cookie. Respostas de erro incluem code e correlationId, sem SQL, conteúdo ou caminho local. O processo exige segredo de ambiente externo ao repositório; graceful shutdown fecha Fastify e a conexão SQLite.
