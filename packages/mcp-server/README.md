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
