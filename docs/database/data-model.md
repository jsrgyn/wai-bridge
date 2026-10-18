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
