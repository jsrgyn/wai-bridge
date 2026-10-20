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

## Schema11 — logs operacionais

`wa_flow_logs`: sequence incremental, id único, trace_id, resource_id opcional, component, level, received_at e event_json validado pelo contrato compartilhado. Índices por trace, recurso, componente e recebimento. `wa_outbox.flow_trace_id` preserva correlação fora do payload/idempotency hash; registros antigos usam o ID do comando. Logs têm retenção independente de sete dias/20 mil linhas e não substituem auditoria/estado. Apenas a API escreve/lê SQLite. ADR0016.

## Schema12 — revisões de captura

wa_capture_message_refs ancora (extension_instance_id,reference_key) em conversa/mensagem, revisão mais recente, observação e primeiro horário. wa_capture_normalizations permite várias observações para a mesma mensagem e status MESSAGE_UPDATED, preservando dados existentes. Índice por message_id mantém projeção/paginação sem linhas duplicadas. Revisões atualizam texto/FTS/metadados; não mudam sequência nem marcam READ. Observações antigas ficam em staging; divergência de referência/direção reverte transação. Nenhuma união por nome/texto.

## Jobs de conferência visível (migration013)

`wa_dialogue_sync_requests` guarda request JSON validado, chave de idempotência única, estado com CHECK, instância/conta/lease, resultado JSON, criação/expiração/conclusão e índice de pendentes. Resultado inclui UUID da conversa e messageIds ordenados, sem duplicar corpos (mantidos em observações/mensagens existentes). TTL30s limita execução, não apaga histórico de pedidos. Conclusão transaciona observações+normalizações+resultado; erro reverte snapshot inteiro. Referências antigas não são unidas por nome. Claim é mutuamente exclusivo com envios, incluindo wa_outbox_interface_lease; sender também bloqueia durante sync CLAIMED não expirado. Replay de conclusão recupera resultado persistido. Backup consistente antecede migration em dados reais. Não há remoção automática de dados nem rollback destrutivo.

### Migration014 — revisão de conversas

`wa_conversation_reviews` mantém revisão monotônica, watermark verificado/confirmado, contagem de sinais, indicação WhatsApp e horários, último job e confirmação. `wa_conversation_review_signals` deduplica por observation_id e vincula revisão local. `wa_conversation_review_links` associa referências explicitamente nos dois sentidos sem fundir histórico. `wa_dialogue_sync_requests` recebe review_conversation_id/review_revision (claim watermark). Normalização e sinal são atômicos; snapshot/job/verifiedRevision também. ACK usa transação imediata e revisão exata; atualização da projeção não altera AI message state. Estágios derivados dos jobs persistidos; não armazenar status duplicado na extensão. Migration semeia sinais antigos conservadoramente e preserva checksums1..13.

### Migration015 — contatos locais e batch de conferência

`wa_contacts` recebe nickname/full_name nullable, sem inferir valores; índice created_at/id. Diretório lê dados via SQL parametrizada, normalização Unicode determinística em função SQLite local e limites UTC derivados do calendário/fuso IANA. Não modifica APIs de contatos legadas.

`wa_dialogue_sync_batches`: intenção/idempotência, conta, status, run_token para retomada explícita, paused_position para selecionar exatamente o item interrompido, motivo e prazo24h. `wa_dialogue_sync_batch_items`: array persistido por position, referência única por lote, query congelada, status, sync_request_id, tentativas e código. Índices únicos garantem um RUNNING global e um ACTIVE por lote. Child jobs criados na vez mantêm lease/TTL30s/quota existente e persistência atômica de snapshots. Expiração/incerteza pausa, não repete; resume gera novo run_token e só retry explícito recria tentativa falha. Cancelamento troca jobs ativos para FAILED/CANCELLED e bloqueia os restantes sem alterar mensagens já commitadas. Preservar migrations1..14 e históricos, inclusive referências duplicadas sem prova de identidade.

Schema16/ADR0021 acrescenta wa_contact_catalog (sobreposição local versionada sem alterar prova de telefone observado), wa_management_replays (hash do payload e referência do recurso, sem cópia de campos pessoais), wa_reference_decisions (par ordenado LINK/DISMISS, sem união de históricos), wa_conversation_policies (favorite/priority/batch_mode), wa_extension_telemetry (por instância), wa_maintenance_settings e wa_backup_runs. Dados de catálogo e replay são privados como o restante do SQLite; não entram em logs. Migration016 aditiva, preserva migrations1..15 e seus checksums. Nenhuma política de manutenção elimina contatos/mensagens/anexos/auditoria/snapshots.
