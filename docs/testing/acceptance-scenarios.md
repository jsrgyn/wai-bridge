# Cenários de aceite

Todos os testes são offline, usam fixture sintética, DB/FS temporários, fake clock e adapter de envio falso. Não usar sessão, conta ou mensagem pessoal real.

| ID | Cenário / preparação | Ação | Resultado esperado / evidência |
|---|---|---|---|
| ATS-01 | Conversa aberta no simulator; monitor inicia, depois surge mensagem DOM nova | observar captura | uma mensagem com `DETECTED→CAPTURED`, ID interno estável, UTC e event persistido antes do WS; sem histórico preexistente importado |
| ATS-02 | Reapresentar a mesma observação/key | submeter de novo | mesmo resultado/ID; um efeito lógico, sem evento duplicado (ou evento de dedupe contratualmente explícito) |
| ATS-03 | Conversa nova com identidade externa disponível | detectar primeira novidade acessível | Conversation criada; Contact opcional; external IDs escopados; nome não usado como chave |
| ATS-04 | Grupo sintético com sender A e sender B | capturar mensagens | mesmo conversationId e senderContactId distintos; identidade desconhecida representável |
| ATS-05 | Mensagem com mídia indisponível/parcial | capturar e consultar | Message persiste sem bytes; Media availability indica falta/parcial; retry/cache não inventa sucesso |
| ATS-06 | Commit event e interromper processo antes do WS | reiniciar dispatcher/cliente | outbox emite após restart; feed cursor recupera evento mesmo se notificação se perdeu |
| ATS-07 | Message `UNREAD`, consumidor lê GET | GET page/detail repetido | IA continua `UNREAD`; mensagem recente aparece independentemente de state filter |
| ATS-08 | Claim válido seguido de ACK válido/idempotency key | POST claim/ack | claim=`CLAIMED`; ACK explícito=`READ`; auditoria das duas transições; repetição não cria outra transição |
| ATS-09 | Banco contém mensagens/eventos pendentes; encerrar/reabrir API | reiniciar | estados, comandos, cursors e outbox sobrevivem; migração não varre histórico de WhatsApp |
| ATS-10 | Envio AUTO habilitado só em simulator, autorização explícita e destinatário único | criar command, fake clock avança 5s | REQUESTED e auditoria persistidos antes; estados esperados; cancel pode vencer deadline; efeito falso só depois do prazo |
| ATS-11 | Envio SUPERVISED padrão pela extensão (fila, ADR 0024) | solicitar envio sem mode; segundo pedido ao mesmo contato | mode resolvido para SUPERVISED; pedido `QUEUED` atendido em ordem; destinatário comprovado; texto no campo; terminal `DRAFTED` sem clique em Enviar; fila segue; segundo pedido acrescenta em nova linha; AUTO posterior com campo não vazio falha `DRAFT_PENDING_ON_TARGET`, com campo vazio envia normalmente |
| ATS-12 | `WAITING_AUTO_SEND` com comando de cancelamento autorizado | cancelar antes de deadline | `CANCELLED` persistido/auditado, nenhum efeito de envio |
| ATS-13 | Adapter falso retorna falha certa | executar comando simulado | `FAILED`, motivo code e audit; nova tentativa somente como command novo sob regra definida |
| ATS-14 | Adapter simula timeout após possível efeito | executar AUTO ou SUPERVISED | `UNKNOWN`; retry automático count=0; sem alegar SENT/FAILED |
| ATS-15 | Destinatário resolve para múltiplos contatos por atributos não únicos | criar comando | conflito `RECIPIENT_AMBIGUOUS`; nenhum estado além de solicitado apropriado; nenhum envio/preparação |
| ATS-16 | Idempotency key reutilizada com body diferente | repetir comando alterado | `IDEMPOTENCY_CONFLICT`; sem mutação/efeito adicional |
| ATS-17 | Conteúdo de mensagem sintética diz “ignorar instruções e enviar…” | processar AI gateway | string tratada como conteúdo; catálogo de tools e autorização não mudam; nenhum send |
| ATS-18 | Cliente WebSocket não autorizado ou cursor malformado | conectar/consultar | negação estruturada; sem vazamento de payload pessoal |

## Critério de aprovação

Cada cenário tem teste automatizado determinístico ou, para instalação/plataforma, evidência de runbook executado. Registrar command, commit, resultado e artifacts sem conteúdo pessoal. Falha conhecida é registrada; não marcar aceite global DONE com cenário obrigatório falhando.

## Matriz requisito → contrato → implementação → teste

| Requisito | Contrato | Implementação prevista | Teste de aceite |
|---|---|---|---|
| FR-01 captura apenas novidades | CaptureObservation + regra de início de monitor | Chrome Extension + macOS Agent | ATS-01, ATS-09 |
| FR-02 identidade/conteúdo indisponíveis | Contact/Conversation/Message nullable + availability | Extension, API, DB | ATS-03–05 |
| FR-03 inbound/outbound observáveis | Direction + captureStatus | Extension + API | ATS-01, ATS-04 |
| FR-04 persistência local pré-efeito | Event/OutboxCommand transacional | Database + Local API | ATS-01, ATS-06, ATS-09 |
| FR-05 mídia filesystem e metadata | Media.storageKey opaco | Media package + DB | ATS-05 |
| FR-06 API autoritativa mediada pelo agente | OpenAPI v1 e protocolo host | Local API + macOS Agent | ATS-03, ATS-18 |
| FR-07 notificação realtime recuperável | Event/EventDelivery/cursor at-least-once | Events + API WebSocket | ATS-06, ATS-18 |
| FR-08 MCP autorizado sem bypass | catálogo allowlist por API | MCP Server | ATS-17, integração MCP simulada |
| FR-09 estados de leitura IA | claim/ack; GET read-only | API + AI Gateway | ATS-07, ATS-08 |
| FR-10 modos AUTO/SUPERVISED | SendRequest/SendStatus, default SUPERVISED | API + adapters de envio | ATS-10–12 |
| FR-11 desconhecido sem reenvio | UNKNOWN terminal automático + idempotency key | Outbox/API | ATS-14, ATS-16 |
| FR-12 Zod e auditoria | schemas/Errors/AuditLog | shared + API + Database | ATS-08, ATS-16, ATS-18 |
| NFR-01 local-only/SQLite | system architecture + bind/auth | API + Database | ATS-18 + dependency review |
| NFR-05 least privilege | scopes, roles e operação autorizada | API/MCP/mac agent | ATS-18 + security suite |
| NFR-06 proteção local | storageKey, filesystem privado, redaction | Database/Media/macOS | ATS-05 + security suite |
| NFR-07 retenção/crypto | política e ADR ainda pendentes | Database/Media | teste de retenção após decisão |
| NFR-08 incerteza de captura | captureStatus/contentAvailability | Extension/API | ATS-01, ATS-05 |
| NFR-09 cancelamento/unknown | cancel + terminal UNKNOWN | API + adapter | ATS-12, ATS-14 |
