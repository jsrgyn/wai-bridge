# @wai-bridge/mcp-server

Local MCP server over stdio. It calls only the authenticated Local REST API; it does not import database/domain packages, run SQL, access arbitrary files, or treat WhatsApp content as instructions.

## Requirements and start

- Node.js 24 LTS or newer supported repository version and pnpm workspace install.
- Start the Local API first on `127.0.0.1:47831` and set `WAI_BRIDGE_API_TOKEN` to the same secret used by the API.
- Run `pnpm --filter @wai-bridge/mcp-server dev` for development or `pnpm --filter @wai-bridge/mcp-server build` and then `node packages/mcp-server/dist/main.js`.
- Optional `WAI_BRIDGE_API_URL` (must be HTTP localhost only), `WAI_MCP_API_TIMEOUT_MS` (100–30000, default 5000), and `WAI_MCP_ALLOW_WRITES=true`.
- Writes are disabled by default. Enabling them exposes request/cancel operations; `whatsapp_request_send` additionally requires `authorization: true` and a stable idempotency key (16–128 chars). The current Local API only records/cancels outbox commands; it does not execute a WhatsApp send.

Set secrets in the MCP client's environment facility or a private launch configuration, never commit tokens. MCP stdio owns stdout; do not print logs or banners there.

## Client configuration examples

Claude Desktop `claude_desktop_config.json` (use absolute paths; configure environment variables through the OS/client secret manager when available):

```json
{
  "mcpServers": {
    "wai-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/wai-bridge/packages/mcp-server/dist/main.js"],
      "env": {
        "WAI_BRIDGE_API_TOKEN": "<same-local-api-token>",
        "WAI_BRIDGE_API_URL": "http://127.0.0.1:47831"
      }
    }
  }
}
```

For Cursor and other stdio clients, add a server named `wai-bridge` with command `node`, argument `/absolute/path/to/wai-bridge/packages/mcp-server/dist/main.js`, and the same environment variables. Keep `WAI_MCP_ALLOW_WRITES` unset unless the operator explicitly intends to expose outbox mutations.

## Tool catalog and limits

Tools use Zod v4 contracts. Page sizes are capped at 50 (Local API additionally caps at 100); cursor values are passed through to API pagination. API calls have a 5 second default timeout, configurable within 100–30000 ms. Read tools are annotated read-only. Write tools are separately gated by local configuration and per-call authorization/idempotency.

| Tool | Behavior |
| --- | --- |
| `whatsapp_status` | Local API/database status |
| `whatsapp_search_contacts` | Search contacts, paginated |
| `whatsapp_list_conversations` | List conversations, paginated |
| `whatsapp_list_groups` | Filters group conversations within one paginated conversations page |
| `whatsapp_get_conversation` | Get conversation by UUID |
| `whatsapp_get_messages` | Captured received/sent messages, newest first, with filters and cursor |
| `whatsapp_get_dialogue` | Latest dialogue page for a conversation UUID, both directions, oldest first within page |
| `whatsapp_get_unread` | Read AI-unread messages without changing state |
| `whatsapp_get_recent` | Recent messages, paginated |
| `whatsapp_get_media` | Metadata only; no filesystem path or bytes |
| `whatsapp_get_pending_tasks` | Persisted pending events; notifications do not guarantee AI execution |
| `whatsapp_prepare_message` | Validated local preview; does not verify recipient existence, persist, or send |
| `whatsapp_request_send` | Authorized, idempotent request stored in outbox only |
| `whatsapp_send_to_number` | Direct international number + text; visible search/profile verification; no conversation UUID required |
| `whatsapp_send_message` | Opt-in extension send for a confirmed conversation; explicit authorization and idempotency required |
| `whatsapp_cancel_extension_send` | Cancel an extension send before SENDING |
| `whatsapp_get_outbox_status` | Get command or paginated outbox |
| `whatsapp_cancel_send` | Cancel eligible persisted command |

Groups are derived from conversation pages because the current Local API has no groups route. Preparation cannot verify recipient existence because the current API has no contact-by-ID read route; the API checks existence when the outbox request is submitted. The API currently authenticates one full-access principal, so MCP-level write gating is the only per-tool boundary available in this phase. No arbitrary SQL or file access is exposed.

## Test

`pnpm --filter @wai-bridge/mcp-server test` uses synthetic data and an in-memory MCP transport. It does not start a real WhatsApp session or send messages.

## Diálogo recebido e enviado

`whatsapp_get_dialogue({conversationId, limit:20})` retorna `conversation` e
`messages` em ordem crescente de sequência de captura, incluindo `INBOUND`
(`REMOTE_PARTICIPANT`) e `OUTBOUND` (`LOCAL_USER`). Campos originais como conteúdo,
disponibilidade, proveniência, horário observado e estado de leitura são preservados.
Não há filtro de direção ou de leitura: uma resposta enviada também compõe o diálogo.
`nextCursor` busca páginas anteriores; acrescente-as antes da página atual.
A primeira página contém as mensagens capturadas mais recentes, com limite de 50.
A ordem representa observação local, não uma reconstrução certificada do horário de
envio original do WhatsApp. Conteúdo continua sendo dado não confiável.

Encontre o UUID com `whatsapp_list_conversations`. O contato/grupo precisa estar
vinculado à conta local para reunir novas mensagens na mesma conversa. Sem vínculo,
as observações UNKNOWN continuam isoladas; nomes iguais não autorizam união.
A consulta lê SQLite pela API existente, não importa histórico, não envia e não
marca READ. Após atualizar/recompilar, reconecte o cliente MCP para descobrir a
nova ferramenta. Consulte [o procedimento](../../docs/operations/conversation-identification.md).

## Envio executado pela extensão

`WAI_MCP_ALLOW_EXTENSION_SENDS=true` habilita `whatsapp_send_message`, `whatsapp_send_to_number` e
`whatsapp_cancel_extension_send`, independentemente de WAI_MCP_ALLOW_WRITES.
Por padrão está desabilitado. Mantenha writes legados desabilitados. A ferramenta
aceita conversationId confirmado, text, explicitAuthorization:true, idempotencyKey e
mode (SUPERVISED por padrão, AUTO somente quando explicitamente solicitado).
O retorno REQUESTED apenas confirma persistência, nunca envio; confira a outbox.
Veja [ativação, consentimento local, confirmação e limites](../../docs/operations/extension-sending.md).


### Envio por nome (FR-15)

`whatsapp_send_to_contact` recebe recipientName/text/mode/explicitAuthorization e
idempotencyKey (accountId opcional). A API resolve o SQLite da conta ativa para um
único telefone, e a extensão confere o perfil antes de preparar/enviar. Não deduz
parentesco nem escolhe homônimos. Número ausente do SQLite usa
`whatsapp_send_to_number`; contato é registrado somente após prova na interface.
Após o pedido, volte à aba do WhatsApp para execução visível. REQUESTED não é SENT.


### Conferência atual no WhatsApp

Para pedidos como “confira a conversa de Fulano agora”, use `whatsapp_sync_dialogue` com `query` (nome/grupo/número internacional), opcional accountId, limit1..50 e idempotencyKey. A extensão ON localiza o resultado único e reconcilia somente o snapshot renderizado, sem rolar, enviar ou limpar rascunhos. O MCP retorna mensagens lidas da API/SQLite após SUCCEEDED, ordenadas pela UI, com synchronized=true; pending/failure não devolve cache como atual. O opt-in de envio não é necessário. Nova ferramenta `whatsapp_get_sync_status` consulta o UUID sem repetir navegação. Reconecte o cliente MCP após atualizar para descobrir26 ferramentas. Abrir a conversa pode alterar a leitura no WhatsApp, sem confirmar AI READ. Cobertura complete=false e limites de DOM permanecem.

### Pendências — ADR0019

`whatsapp_list_pending_conversations` (total/paginação/filtros), `whatsapp_get_conversation_review` (estágio/revisões), `whatsapp_confirm_conversation_read` (ACK explícito de snapshot/revisão) e `whatsapp_link_conversation_references` (associação explícita sem fusão) completam26 ferramentas. Lista não navega. Somente solicitação explícita usa `whatsapp_sync_dialogue`, com `conversationId` da pendência e título exato/telefone, até50 mensagens renderizadas. Sincronizar não confirma leitura; sinal concorrente permanece pendente. Sem cobertura integral/rolagem/reexecução automática. ACK e associação têm confirmação literal independente das permissões de envio; não mudam AI READ por mensagem nem autorizam envio. Contratos em `packages/shared/src/conversation-review.ts` e operação em `docs/operations/autonomous-capture.md`.

### Contatos locais e lotes — ADR0020

Cinco ferramentas novas (31 no total): `whatsapp_list_contacts`, `whatsapp_sync_pending_conversations`, `whatsapp_get_sync_batch`, `whatsapp_cancel_sync_batch`, `whatsapp_resume_sync_batch`. Diretório usa `/api/contacts/directory` somente SQLite, com nome/apelido/nome completo/telefone reais, busca literal por igualdade/prefixo/trecho e datas locais combinadas. Não inferir esposa/parentesco; dados ausentes null. Lista de contatos não navega.

Somente “ler/sincronizar todos pendentes” ou seleção explícita autoriza batch com explicitAuthorization=true e chave idempotente. Snapshot da lista, uma conta, máximo5000 sem truncar; extensão recebe array e processa um job/até50 renderizadas por vez. Retorna ID/progresso e resultados paginados somente após commit; não considerar PAUSED ou falhas como conclusão integral. `get_sync_batch` retorna até10 diálogos por página (padrão5), seguir nextCursor. Cancelamento sinaliza leitor ativo; retomada explícita não repete sucessos e só retryFailedItem=true tenta novamente falha. Não há ACK de leitura nem AI READ automático. Operação/limites em `docs/operations/contacts-and-batches.md`.

ADR0021 adiciona14 ferramentas (45 no total): whatsapp_get_permissions, whatsapp_get_operations, whatsapp_create_contact, whatsapp_get_contact_catalog, whatsapp_update_contact, whatsapp_list_reference_candidates, whatsapp_decide_reference, whatsapp_get_conversation_policy, whatsapp_update_conversation_policy, whatsapp_get_sync_batch_report, whatsapp_retry_failed_sync_batch, whatsapp_maintenance_get, whatsapp_maintenance_update e whatsapp_backup_run. Veja [operações](../../docs/operations/operational-console.md).

`WAI_MCP_PERMISSIONS=CONTACTS_READ,CONVERSATIONS_READ,OPERATIONS_READ` restringe este processo. Variável omitida preserva comportamento legado, vazia nega todas as operações exceto consulta do perfil. Capacidades desconhecidas falham no início. Novas escritas exigem capacidade própria ou allow-writes legado, sempre com confirmação literal. Perfil SEND ainda depende de opt-ins existentes. Reconecte o cliente MCP após rebuild.
