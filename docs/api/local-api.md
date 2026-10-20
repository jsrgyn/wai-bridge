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

## Captura e cobertura (schema12)

POST /api/observations aceita messageRef opcional (UUID key, revision positiva, firstObservedAt UTC não posterior a observedAt). MESSAGE atualiza projeção por referência local da instância; observações permanecem imutáveis. Replay do mesmo ID é idempotente; revisão mais antiga não sobrescreve. Conflitos de conversa/direção são409. CONVERSATION_ACTIVITY pode usar identidade UI_CONTEXT para vincular sinais à linha, sem conteúdo de mensagem presumido.

GET /api/conversations aceita q opcional (2–100 caracteres, busca literal por título) com paginação existente. GET /api/conversations/:id/capture-coverage retorna CaptureCoverageSchema estrito, incluindo contagens, últimos20 sinais de atividade e complete=false. Mensagens incluem até16 metadados de mídia sem caminhos/bytes, mediaCount e mediaTruncated. MCP whatsapp_list_conversations aceita query; whatsapp_get_dialogue inclui captureCoverage. Fonte continua somente UI observada.

### Reconciliação deliberada de diálogo (schema13 / ADR0018)

- `POST /api/dialogue-sync`: `DialogueSyncRequestSchema` — query2..100, accountId opcional, limit1..50 (50), idempotencyKey16..128. Retorna202 com `DialogueSyncResultSchema`, persistido antes da navegação.
- `GET /api/dialogue-sync/:id`: estado e cobertura; desconhecido404.
- `GET /api/dialogue-sync/:id/messages`: somente SUCCEEDED; mensagens persistidas nos IDs/ordem do snapshot UI e nextCursor=null; estado não concluído409. Não retorna corpos diretamente da extensão.
- `POST /api/extension/dialogue-sync/poll`: `DialogueSyncPollSchema`; preflight ready=false retorna pending sem claim. ready=true exige accountId; somente uma execução e nenhuma interface ocupada por envio. Retorna job/null.
- `POST /api/extension/dialogue-sync/complete`: `DialogueSyncCompletionSchema`; até50 observações, limite HTTP4MiB apenas nesta rota. Lease e instância autenticam execução; identidade/conta/título/referências precisam coincidir. Observações e estado final são atômicos; replay de completion concluído não duplica. Falha de contexto/revisão reverte snapshot inteiro; nunca informar sucesso parcial como completo.

Estados REQUESTED/CLAIMED/SUCCEEDED/FAILED/EXPIRED, TTL30s, no máximo20 pedidos pendentes, idempotência por chave e igualdade do request. Campos incluem conversationId, messageIds ordenados, observedCount/persistedCount, unknownDirectionCount, truncated, code, createdAt/completedAt/expiresAt, scope=VISIBLE_RENDERED_ONLY e complete=false. Não une conversas históricas por nome, baixa mídias, rola histórico, envia mensagens ou confirma AI READ. Rotas continuam Bearer/local e SQLite exclusivo da API. Permissão de envio não é pré-requisito para conferência solicitada; monitor ON é obrigatório na extensão.

## Pendências de conversas — ADR0019

Todas as rotas exigem bearer local e contratos Zod estritos:

- `GET /api/conversation-reviews`: ConversationReviewQuerySchema → ConversationReviewPageSchema (`total`, `nextCursor`, `complete:false`). `pendingOnly=true` por padrão; `accountId`, `query`, `stage`, `limit1..100`, cursor UUID. Leitura paginada em ordem estável de UUID, sem navegação ou ACK.
- `GET /api/conversation-reviews/:id`: ConversationReviewItemSchema; estágio derivado de sinais/revisões/jobs persistidos, incluindo expiração por prazo.
- `POST /api/conversation-reviews/:id/ack`: `{syncRequestId,revision,explicitConfirmation:true}`. Exige último snapshot SUCCEEDED e revisão verificada atual, sem novo sinal. Replay idempotente; 409 REVIEW_STALE_CONFIRMATION; não altera AI READ/WhatsApp.
- `POST /api/conversation-reviews/:id/links`: `{relatedConversationId,explicitConfirmation:true}`. Mesma conta, sem conflito de tipo/telefone; 409 REVIEW_IDENTITY_CONFLICT. Associação auditada e idempotente; não funde históricos ou confirma pendências.

404 para referência inexistente, 400 para contrato inválido, 401 sem token. Indicador de não lidas é metadata observada, não quantidade de mensagens na fila. `signalCount` conta observações elegíveis, não mensagens únicas.

`POST /api/dialogue-sync` aceita `conversationId` opcional para vincular à pendência selecionada; título exato/telefone único da fila também pode vincular pedido deliberado. Incompatibilidade de conta/título/identidade é 409; pedido concorrente para mesma referência é SYNC_ALREADY_PENDING. Watermark da fila é obtido no claim; sucesso só cobre sinais até esse ponto, sem confirmar leitura. Conteúdo reconciliado por esse pedido não gera notificações novas artificiais. Falhas/expiração não apagam pendências nem reexecutam navegação.

## Diretório local e lotes — ADR0020/schema15

- `GET /api/contacts/directory`: ContactDirectoryQuerySchema → ContactDirectoryPageSchema; somente SQLite, nome/apelido/nome completo/telefone nullable, filtros literais normalizados+datas locais, total/paginação. Não altera rotas legadas `/contacts` e `/contacts/search`. `registeredPeriod=TODAY|YESTERDAY`, `registeredOn` ou `registeredFrom/To`, fuso IANA padrão America/Sao_Paulo. Código400 para filtros incompatíveis/invalidade.
- `POST /api/dialogue-sync-batches`: DialogueSyncBatchRequestSchema (`scope=ALL_PENDING|SELECTED`, conversationIds somente SELECTED, accountId opcional, explicitAuthorization:true, idempotencyKey, limitPerConversation1..50).202 retorna DialogueSyncBatchStatusSchema; snapshot imutável até5000, um RUNNING, prazo global24h.409 BATCH_TOO_LARGE/BATCH_BUSY/BATCH_ACCOUNT_REQUIRED/BATCH_ACCOUNT_MISMATCH/IDEMPOTENCY_CONFLICT;404 referência selecionada ausente. Não há truncamento silencioso.
- `GET /api/dialogue-sync-batches/:id?cursor=0&limit=20`: DialogueSyncBatchPageSchema (`batch`, items, nextCursor), até100 itens. Consulta progresso/resultados não cria próximo job. Cada item SUCCEEDED aponta syncRequestId; diálogos lidos pelas rotas persistidas de sync existentes.
- `POST /api/dialogue-sync-batches/:id/cancel`: `{explicitAuthorization:true}` → status. Cancela restante e sinaliza job ativo; idempotente, preserva sucessos.
- `POST /api/dialogue-sync-batches/:id/resume`: `{explicitAuthorization:true,retryFailedItem:false}` → status. Somente PAUSED; novo runToken, sucessos não repetidos; retryFailedItem=true cria nova tentativa do item que causou a pausa.409 para terminal/busy.

Todos autenticados por bearer local, contratos Zod estritos, logs sem dados privados. Native `SYNC_POLL` aceita `activeRequestId`+`leaseToken` juntos para consultar interrupção do leitor atual com instance/account exatas; resposta opcional cancelRequestId. Job opcional batch inclui id/runToken/posição/total/array de UUIDs. Extensão não decide transições nem acessa banco. ACK de leitura de pendência não é automático.

## Gestão operacional — ADR0021/schema16

Contratos de entrada/saída em `packages/shared/src/operations.ts`; todas as rotas abaixo exigem bearer local. Sem token no dashboard. Ver [guia operacional](../operations/operational-console.md) para semântica, limites e ativação.

| Rota | Contrato e comportamento |
| --- | --- |
| POST /api/contact-catalog | ContactCreateSchema →201 ContactCatalogSchema; confirmação e chave idempotente |
| GET /api/contact-catalog/:id | ContactCatalogSchema; campos locais e versão |
| PATCH /api/contact-catalog/:id | ContactUpdateSchema →ContactCatalogSchema; expectedVersion;409 conflito/replay divergente |
| GET /api/reference-candidates | CandidateQuerySchema →ReferenceCandidatePageSchema; proposta paginada |
| POST /api/reference-candidates/decisions | CandidateDecisionSchema; LINK/DISMISS explícito, historiesMerged=false |
| GET /api/conversation-policies/:id | ConversationPolicySchema |
| POST /api/conversation-policies/:id | PolicyUpdateSchema →ConversationPolicySchema; não inicia lote |
| GET /api/operations | OperationSummarySchema +runtime de /status; dados locais e telemetria parcial |
| GET /api/dialogue-sync-batches/:id/report | DialogueSyncBatchPageQuerySchema →DialogueSyncBatchReportSchema |
| POST /api/dialogue-sync-batches/:id/retry-failed | RetryBatchFailuresSchema →202 status de novo lote;409 NO_FAILED_ITEMS/BATCH_NOT_TERMINAL |
| GET /api/maintenance | MaintenanceStatusSchema; últimos20 backups |
| POST /api/maintenance | MaintenanceUpdateSchema →MaintenanceStatusSchema; prune exige autorização específica |
| POST /api/maintenance/backup | {explicitConfirmation:true} →BackupResultSchema;503 se serviço indisponível |
| POST /api/extension-telemetry/:id | ExtensionTelemetrySchema; ID instância UUID; métricas sem conteúdo |

Native adiciona MANAGEMENT(input:ManagementRequestSchema), MANAGEMENT_RESULT(result JSON) e MANAGEMENT_FAILURE(code sanitizado), handshake de instância obrigatório, até10 pedidos concorrentes/timeout35s na extensão; rotas fixas no host sem URL arbitrária. HEARTBEAT aceita telemetria opcional para preservar clientes anteriores. Contatos observados e catálogo manual não são misturados no resolvedor de envio legado.
