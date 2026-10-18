# Diretrizes de schema SQLite

Este documento define estratégia, não DDL final. SQLite exclusivo, mantido pelo Local API como único processo com conexão operacional. Melhorias/migrações precisam de número monotônico e hash/versionamento, transação, backup e plano de rollback/forward compatível.

## Tipos e integridade

- `id`: UUIDv7 em `TEXT` com formato validado em Zod.
- Horários: RFC 3339 UTC em `TEXT`, com `Z` e milissegundos; nunca horário local sem offset.
- Estado: `TEXT` com `CHECK` do enum e validação Zod na aplicação.
- Payload/metadado estruturado: JSON UTF-8 validado pelo schema de versão; não guardar bytes de mídia no banco.
- FKs habilitadas; cascades destrutivos não implícitos. Deletes seguem retenção explícita.
- Query parametrizada. Escritas de aggregate + evento + outbox + audit no mesmo transaction quando aplicável.
- Índices: external identity por connector/scope/id; message por conversation/sequence; capture/idempotency keys; Event por sequence; outbox por status/next attempt; audit por resource/time.

## Atomicidade e entrega

Commit SQLite antes de qualquer broadcast ou ação externa. Outbox dispatcher só seleciona comandos confirmados e marca tentativa de forma recuperável. Crash após efeito e antes de guardar resultado pode produzir UNKNOWN; não assumir “exactly once”. WebSocket entrega at-least-once e usa event ID/cursor; estado é recuperado por API.

## Segurança operacional

Diretório privado com permissões mínimas; considerar WAL/journal, backup consistente, restauração ensaiada e exclusão de backups do Git. Guardar `storageKey` opaco, nunca caminho arbitrário fornecido pela extensão. Retenção, cifragem e chave necessitam ADR. Arquivos do usuário nunca são limpos por migration sem autorização.

## Decisões pendentes antes de DDL

Retenção numérica por classe de dado, política de eliminação, estratégia de backup, criptografia/chaves, escopo de idempotency key, formato final de cursor e se `EventDelivery` rastreia consumidores persistentes ou somente sessões. Não inventar durante implementação.

## Mídia (migration 004)

`wa_media` mantém o vínculo obrigatório com `wa_messages`. A migration 004 adiciona `processing_status` (`DETECTED`, `AVAILABLE`, `CACHING`, `CACHED`, `UNAVAILABLE`, `FAILED`, `REMOVED`), `duration_ms`, `caching_started_at`, `cached_at`, `verified_at`, `removed_at` e `error_code`, com índices para retenção e deduplicação por hash/chave. A coluna legada `availability` continua para compatibilidade de leitura da API; o estado detalhado é `processing_status`. `storage_key` é relativo e gerado pelo servidor. Bytes nunca são gravados no SQLite. Transições de status usam transação e `wa_audit_log` sem conteúdo de mídia.
