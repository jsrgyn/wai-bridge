# Modelo conceitual de dados

Todos IDs internos são UUIDv7 gerados localmente e imutáveis. IDs externos são opcionais, acompanhados de conector/escopo e não únicos globalmente. Timestamps persistidos em UTC RFC 3339 com milissegundos; ordem monotônica local `sequence`/cursor resolve empate/clock skew. PII/conteúdo minimizados e política de retenção pendente de ADR. Tabelas abaixo são conceitos, não migração aprovada.

| Entidade | Campos/relacionamentos principais | Restrições |
|---|---|---|
| Contact | `id`, `externalId?`, `connector`, `displayName?`, `identityStatus`, timestamps | `displayName` não é unique; external ID unique apenas `(connector, accountScope, externalId)` quando confiável |
| Conversation | `id`, `externalId?`, `kind` (`DIRECT/GROUP/UNKNOWN`), `title?`, status | nomes/títulos não identificam; external key escopada |
| GroupMember | `conversationId`, `contactId?`, `externalMemberId?`, `displayName?`, `firstSeenAt`, `lastSeenAt` | unique por conversa + identidade externa válida; remetente pode permanecer desconhecido |
| Message | `id`, `conversationId`, `senderContactId?`, `direction`, `externalId?`, `captureStatus`, `content?`, `contentAvailability`, `observedAt`, `capturedAt?`, `sequence`, `idempotencyKey?` | grupo distingue conversation do sender; conteúdo pode ser ausente/parcial; external ID escopado |
| Media | `id`, `messageId`, `mediaType?`, `mimeType?`, `size?`, `sha256?`, `storageKey?`, `availability`, timestamps | bytes no FS; path opaco criado pelo servidor |
| MediaAnalysis | `id`, `mediaId`, `analysisType`, `status`, `resultRef?`, `createdAt`, `completedAt?` | resultado/versionamento e conteúdo sensível minimizados |
| AIMessageState | `messageId`, `state`, `version`, `claimedBy?`, `claimToken?`, `updatedAt`, `lastErrorCode?` | um estado corrente por mensagem; transições auditadas; GET read-only |
| Event | `id`, `type`, `aggregateType/id`, `sequence`, `occurredAt`, `payloadVersion`, `payload`, `idempotencyKey?` | append-only lógico; payload validado e sem segredos |
| EventDelivery | `eventId`, `consumerId`, `attempt`, `status`, `cursor`, `deliveredAt?`, `ackedAt?` | at-least-once; transport ACK distinto de AI ACK |
| OutboxCommand | `id`, `kind`, `idempotencyKey`, `requestHash`, `status`, `createdAt`, `nextAttemptAt?`, `leaseOwner?`, `leaseUntil?`, `attemptCount`, `resultRef?` | unique da chave no escopo principal; lease de claim; UNKNOWN terminal |
| OutboxHistory | `id`, `commandId`, `fromStatus?`, `toStatus`, `actor`, `at`, `reasonCode?`, `correlationId` | append-only para toda mudança de estado |
| ExtensionState | `id`, `extensionInstanceId`, `conversationId?`, `lastObservationKey?`, `lastSeenAt`, `status` | sem credenciais; não é prova de captura total |
| SyncState | `id`, `scope`, `cursor`, `updatedAt`, `version` | cursor local opaco; sem histórico backfill |
| AuditLog | `id`, `actorType/id?`, `action`, `resourceType/id`, `at`, `outcome`, `correlationId`, `metadataRedacted` | append-only; sem tokens/conteúdo integral por padrão |

## Chaves e consultas

- IDs primários internos não derivam de telefone, nome, título ou ID externo.
- Idempotência: `scope + idempotencyKey` unique, armazenando request hash; reutilizar chave com hash diferente retorna `IDEMPOTENCY_CONFLICT`.
- Mensagens recentes consultam por `(conversationId?, sequence DESC, id)` sem filtrar AI state por padrão.
- Feed de evento usa cursor opaco e sequence, não offset.
- Retenção e índices de remoção não devem apagar eventos/auditoria necessários sem política explícita.
## Referências de conversa confirmadas (schema 8)

`wa_conversation_identities` relaciona uma conversa interna a account_id local,
reference_type PHONE/GROUP_LOCAL e reference_key (telefone normalizado ou UUID local).
A chave é única por conta/tipo/referência. Telefone pode apontar a peer_contact_id
PARTIAL; grupo não transforma nome de participante em identidade. Source e
confirmed_at registram a origem da associação; o contexto completo fica na observação.

`wa_capture_normalizations` permite múltiplas observações por conversation_id,
mantendo observation_id como PK e message_id único. Sequence é alocada na transação
da normalização. Migração 008 preserva os links anteriores ao reconstruir essa tabela.
Cadastros de exibição da extensão permanecem em chrome.storage.local; ver ADR 0009.

## Diálogo bidirecional verificado (2026-10-18)

A implementação SQLite vigente usa uma única `wa_messages` para as duas direções:

| Campo | Significado no diálogo |
| --- | --- |
| `conversation_id` | Mesma conversa para entradas/saídas de uma referência confirmada por conta |
| `direction = INBOUND` | Entrada: mensagem recebida do contato ou participante |
| `direction = OUTBOUND` | Saída: mensagem enviada manualmente pelo usuário e observada na interface |
| `sender_contact_id` | Remetente remoto quando conhecido; NULL em saída, sem inventar contato próprio |
| `sequence` | Ordem monotônica de captura dentro da conversa; unicidade por conversa |
| `content`, `content_availability` | Conteúdo observado ou indicação explícita de indisponibilidade |
| `observed_at` | Horário de observação local em UTC; não certifica horário original de envio |

CHECK de direção e UNIQUE(conversation_id,sequence) já existem na migration 001.
A migration 008 permite várias observações ligadas à mesma conversa confirmada.
Este ajuste não exige migration adicional nem altera o banco antigo. Mensagens
UNKNOWN anteriores permanecem isoladas e não são reunidas por nomes.

MCP `whatsapp_get_dialogue` lê a conversa e sua página recente pela API, inclui
ambas as direções e retorna a página em sequência crescente. `speaker` é apenas
apresentação derivada da direção (`LOCAL_USER`/`REMOTE_PARTICIPANT`), não nova
identidade persistida. Páginas anteriores são indicadas por `nextCursor` e devem
ser acrescentadas antes da atual. Consulta não marca READ nem acessa WhatsApp.

## Automatic visible references (migration 009)

wa_conversation_identities also accepts UI_CONTEXT/VISIBLE_UI with a local UUID.
Identity remains PARTIAL. confirmed_at records observation time for this source.
Existing PHONE/GROUP_LOCAL references are preserved. Equal labels are not joined;
reloads/virtualized row replacement may create another reference. Incoming and
outgoing observations with the same reference normalize to the same conversation.

## Contato com nome e telefone (migration 010)

`wa_contacts.display_name` guarda o nome observado e `phone_number` guarda telefone
internacional normalizado (+DDI), nullable e indexado. Não se deduz DDI nem telefone
por nome. Migration 010 preenche apenas números de referências PHONE/PROFILE_PHONE
já vinculadas e sem conflito; external_id de outros conectores não vira telefone.
O grupo mantém `wa_conversations.title`, exposto como groupName. O nome observado
no WhatsApp tem prioridade sobre o apelido manual local.

UI_CONTEXT pode informar phone apenas para INDIVIDUAL. Quando um perfil visível
corresponde ao nome da conversa e tem um único telefone internacional visível, esse
número enriquece o contato existente sem mudar o ID da conversa. Conflito de
telefone/tipo é rejeitado; nomes iguais não unem contatos. Dados continuam PARTIAL.
