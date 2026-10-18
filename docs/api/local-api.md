# Local API — comportamento atual

A API fornece os endpoints listados em `openapi.yaml`. A única rota pública é `GET /health`; o restante exige um bearer token local configurado via `WAI_BRIDGE_API_TOKEN` (mínimo de 32 caracteres). Atualmente o token representa um único principal local de acesso total; escopos distintos por endpoint ainda não existem. A API de produção liga-se somente a `127.0.0.1`.

Todas queries e bodies são validados por Zod, paginação aceita `limit` entre 1 e 100 e cursor opaco. Mensagens globais são ordenadas por `observedAt,id`; consultas por conversa usam sequência local. `GET` nunca altera estado IA; claim/ACK são operações autenticadas e ACK válido exige consumidor e claim token coincidentes.

`GET /api/media/:id` fornece metadados sem caminho local nem bytes. O pacote `packages/media` descrito na auditoria anterior está ausente nesta cópia; não há ingestão/upload/download integrado. O AI Gateway não carrega bytes por caminho; uma integração deve fornecer bytes explicitamente e habilitar provider externo para transferir mídia.

`POST /api/observations` persiste observação, normalização e eventos na mesma transação (schema 7). Cada observação tem uma conversa interna própria: nomes visíveis não são chaves de identidade. Mensagens com direção conhecida são consultáveis em `/api/messages`, incluindo `sourceObservationId` e `identityStatus: UNKNOWN`; as conversas retornam a mesma proveniência. Sender inbound com nome visível cria contato UNKNOWN, sem external ID; outbound não infere contato. Essas identidades não passam na verificação de destinatário do outbox. As conversas ficam fragmentadas por observação até existir reconciliação explícita de identidade (ADR 0008).

Atividade de conversa não cria mensagem. MESSAGE com direção UNKNOWN permanece staged, com normalização DIRECTION_UNKNOWN. Hints de mídia geram metadados indisponíveis, sem bytes. Captura inicia UNREAD; consultas MCP não confirmam leitura. Reenvio do mesmo ID/payload reaproveita os registros; outro payload/instância causa 409. Não há backfill automático; retransmissão explícita pode normalizar uma observação staged antiga. O envelope CaptureResult permanece compatível e seu eventId aponta para o evento da observação.

AI reading tem endpoints autenticados por consumidor: `POST /api/ai/consumer-claims` cria lease (1s–24h; padrão 60s), `POST /api/ai/consumer-ack` confirma explicitamente `READ`, `POST /api/ai/consumer-fail` registra falha e `GET /api/ai/consumers/{consumerId}/recoverable` recupera mensagens UNREAD/FAILED ou claims expirados. Estado é persistido em `wa_ai_consumer_message_state` por mensagem e consumidor. A query `GET /api/messages?consumerId=...&aiState=...` lê esse estado sem mutação. A tabela legada de estado global e endpoints `/ai/claims`/`/ai/ack` permanecem para compatibilidade.

`POST /api/outbox` persiste comando idempotente em `REQUESTED`; o dispatcher avança comandos SUPERVISED até `WAITING_USER`. O runtime usa verificador AUTO que nega autorização e executor simulado; não existe envio real. `POST /api/outbox/:id/cancel` cancela antes de `SENDING` e interrompe espera automática; `POST /api/outbox/:id/result` registra resultado manual, exigindo `evidenceRef` para `SENT`. UNKNOWN é terminal e não é repetido.

Logs Pino redigem URL, body, bearer e cookie. Respostas de erro incluem code e correlationId, sem SQL, conteúdo ou caminho local. O processo exige segredo de ambiente externo ao repositório; graceful shutdown fecha Fastify e a conexão SQLite.

Desde o schema 8, MESSAGE pode trazer `identity` opcional versionada, descrita no
ADR 0009: conta local UUID, contexto UUID, horário de confirmação e referência
PHONE/PROFILE_PHONE ou GROUP_LOCAL/USER_GROUP. Telefone deve estar normalizado com
DDI explícito; grupo usa UUID local e apelido confirmado. Tipo precisa corresponder
à conversa, e confirmação não pode ser posterior à observação. Sem identidade,
permanece a política UNKNOWN do ADR 0008. Uma referência agrupa novas observações
por conta + tipo + chave e aloca sequência transacional por conversa. API/MCP retornam
PARTIAL, localAccountId e identitySource; envio não é habilitado e sender de grupo
não é resolvido por nome. Conversas agregadas retornam uma observação representativa
em sourceObservationId; mensagens mantêm a proveniência individual. Cadastro errado
de conta/grupo continua sendo possível, por se tratar de confirmação humana local.

## Entrega de envios pela extensão (ADR 0010)

- POST /api/extension/outbox: ExtensionSendRequestSchema + header idempotency-key;
  persiste kind extension-send somente para conversa com referência confirmada.
- POST /api/extension/outbox/poll: ExtensionSendPollSchema, com instância e identidade
  atual; retorna null ou um comando com lease/token/contexto (exclusivo do native host).
- POST /api/extension/outbox/progress: ExtensionSendProgressSchema; valida lease,
  contexto, transição e countdown; ACK SENDING deve preceder o clique.
- POST /api/extension/outbox/:id/cancel: cancela somente antes de SENDING.

Schemas Zod versionados em packages/shared/src/extension-send.ts. Todas as rotas
exigem o Bearer local já existente. Token da API não é exposto à extensão. Status
público continua em /api/outbox/:id e omite lease_owner para extension-send. Resultado
legado /api/outbox/:id/result não pode marcar esses comandos como enviados.
Expiração pós-SENDING é UNKNOWN sem retry. Nenhuma migração foi necessária.

### Nome e telefone observados

Contatos retornam `displayName` e `phoneNumber` (null quando indisponível).
Busca de contatos aceita nome ou trecho do número. Listagem/detalhe de conversas e
mensagens retornam `contactName`, `contactPhone` e `groupName`; campos sem evidência
ficam null. Os mesmos dados chegam às ferramentas MCP de consulta e ao diálogo,
inclusive em OUTBOUND (o contato é o interlocutor, não o remetente local).

UI_CONTEXT aceita `phone` opcional apenas com conversationKind=INDIVIDUAL. A
extensão lê apenas perfil visível cujo nome corresponde à conversa aberta; não
abre perfis automaticamente nem lê estado privado. Telefones ambíguos, ocultos e
números de participantes de grupo não são atribuídos ao contato da conversa.

### POST /api/extension/outbox/phone

Bearer e header idempotency-key obrigatórios. Corpo segue
ExtensionPhoneSendRequestSchema: phoneNumber com +DDI (formatação aceita), text,
mode AUTO/SUPERVISED (padrão SUPERVISED), explicitAuthorization=true e accountId
opcional. Seleciona uma conta local única com poll autorizado nos últimos 15s ou
exige conta explícita entre as ativas. Persiste intenção extension-send com busca
obrigatória e sem inventar conversationId/contato confirmado. Retorna 202/REQUESTED;
replay retorna o mesmo comando, sem reescolher a conta. Conflitos de conta/chave
retornam 409. MCP whatsapp_send_to_number usa essa rota, sob o gate de envio.

Commands de número direto podem omitir conversationId e devem possuir
locateByPhone=true/recipientPhone. A lease/autorização/retorno permanecem iguais.
Registro de contexto no poll usa scope extension-send-context:<instanceUUID> em
wa_sync_state, com accountId, allowClaim e updated_at; não guarda credenciais,
texto de mensagens ou afirma login oficial de WhatsApp.


### Resolução por nome e prova do destinatário

`POST /api/extension/outbox/recipient` (Bearer + idempotency-key):
`{recipientName,text,mode?,accountId?,explicitAuthorization:true}`. Resolução no
SQLite por conta ativa, nome normalizado exato/trecho e um telefone distinto.
Erros: RECIPIENT_NAME_NOT_FOUND, RECIPIENT_PHONE_REQUIRED, AMBIGUOUS_RECIPIENT,
RECIPIENT_SEARCH_TOO_BROAD; sucesso 202 com id/inserted/status, sem confirmar envio.
O pedido por nome e telefone resolvido permanecem no payload para replay estável.

Poll aceita ready:boolean (padrão true); false atualiza heartbeat mas não claim.
Progresso WAITING_USER/WAITING_AUTO_SEND de locateByPhone exige resolvedIdentity e
conversationLabel. Conta/telefone precisam coincidir com a intenção. A mesma
transação registra contato/conversa observados e associa o UUID ao outbox.
Sem prova retorna RECIPIENT_PROOF_REQUIRED. Não há nova migration.


### Diagnóstico e supervisão de envio (ADR 0015)

GET /api/status acrescenta extension (native, bridge, lastPollAt, protocolVersion,
build, ready, queue por status). Não contém telefone, contato, texto ou lease token.
Poll aceita identity opcional para diagnóstico sem conversa, reason/protocolVersion=2,
clientBuild, visible (readiness observada distinta de ready de claim) e activeCommand
{id,contextId,leaseToken}. Sem identidade não há claim. Preflight ready=false pode
retornar pending=true; activeCommand autenticado retorna activeStatus sem claim.
Conta/opt-in são registrados em escopo por extensão+conta; diagnóstico por instância
fica em extension-send-health. Várias contas na mesma extensão não escolhem a última.
Cancelamento continua pela rota anterior; supervisão transmite término para a aba.

## Logs de fluxo

GET/POST `/api/diagnostics/logs`, autenticados pelo Bearer local. POST aceita FlowLogBatchSchema estrito (1–50 eventos) e retorna 202 `{accepted, inserted}`; GET usa FlowLogQuerySchema (traceId/resourceId UUID, component, level, beforeSequence, limit até100). Header opcional `x-wai-trace-id` UUID correlaciona solicitações; resposta devolve o trace. Consulte [guia de diagnóstico](../operations/flow-logging.md).
