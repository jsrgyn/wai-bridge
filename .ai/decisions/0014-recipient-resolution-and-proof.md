# ADR 0014 — Resolve named recipients and persist visible recipient proof

Date: 2026-10-18. Status: Accepted (requested by user).

## Context

A user may identify a recipient by a stored name or by a number absent from SQLite.
An open profile contains notification checkbox inputs; these do not indicate unsaved
profile edits. The Chrome tab can be selected while hidden behind the MCP client.

## Decision

Add whatsapp_send_to_contact and POST /api/extension/outbox/recipient. The API alone
resolves names within the unique recently active opted-in account. Compare normalized
case/accents/whitespace, prefer exact names then substring; require one distinct
non-null phone across all matches. Never infer relationships or aliases. Duplicate
visual references with the same phone are routing candidates, not merged histories.
Missing/ambiguous names or phones fail; the caller may explicitly supply the number.
Name intent and selected phone are persisted with the original idempotency key.
Replay precedes account selection and lookup, so renames/expiry cannot reroute it.

The extension first searches chats, then the visible new-chat contact directory if
no chat result exists. Only a unique result plus a matching individual profile phone
allows preparation. No private protocol, guessed phone, contact creation in the
WhatsApp address book or deep-link fallback is used. An unavailable UI result fails.

Extend native send-poll with ready (default true for old clients), separate from
opt-in. Hidden tabs still advertise the opted-in account but cannot claim commands.
An executor that becomes hidden before preparation waits for visibility within its
lease, with cancellation; loss of visibility during execution blocks further effects.
No request is replayed. SUPERVISED waiting retains the draft while hidden within
the lease; only the final visible click can authorize sending. Disabled/hidden/expired
gates have separate error codes.

Extend WAITING_USER/WAITING_AUTO_SEND progress with resolvedIdentity and label for
phone searches. The API verifies account and exact phone, persists the observed
contact/conversation and associates the outbox intent atomically before authorizing
SENDING. This uses existing schema 10 and existing identity repository. Normal
capture remains incremental and historical fragments are not silently merged.

Ignore invisible, readonly/disabled, search and checkbox/radio profile controls when
checking for editable profile fields. Visible editable text fields still block closing.

## Alternatives and consequences

MCP-side fuzzy selection and number-only speculative registration were rejected:
the API owns recipient selection and only visible evidence registers a new contact.
No automatic Chrome focus or cross-chat historical scan is introduced. New extension
and native host contracts require rebuilding and reloading the extension and MCP;
old phone-search clients without proof fail safely. SUPERVISED remains manual;
AUTO retains explicit authorization, cancelable countdown, durable SENDING and no
retry for uncertain outcomes. UI compatibility still needs a user validation.

### Correção da classificação de resultados — 2026-10-18

Inspeção de pesquisa real mostrou um contato em Conversas e três resultados na
seção Grupos em comum. Contar todos os cell-frame-container como destinatários
causava AMBIGUOUS_PHONE_RESULTS indevido. No pane-side, somente as seções
Conversas/Chats e Contatos/Contacts participam da seleção. Grupos em comum,
Mensagens e seções desconhecidas não autorizam abrir um destinatário. Diretório
Nova conversa mantém escopo próprio, sem interpretar o título do painel como
seção de resultados. Múltiplos candidatos de contato continuam bloqueados: nomes
iguais não são deduplicados como identidade. O perfil individual e telefone exato
continuam obrigatórios.

A caixa de busca e o título de resultados podem atualizar antes das linhas.
Comparar baseline das linhas, esperar resposta/estabilidade e respeitar busy evita
classificar a lista antiga como ambígua. Sem atualização comprovável retorna
SEARCH_RESULTS_NOT_READY. Não abrir vários perfis por tentativa nem extrair
histórico de mensagens dos resultados. A alteração é no adaptador visível, sem
novo contrato, banco, permissões ou mudança do modo supervisionado.

### Perfil fechado após conferência — 2026-10-19

Após ler o telefone individual completo e normalizado, fechar o painel pelo controle Fechar/Close único. Conservar a prova somente na execução atual, ligada a root DOM, título, conta e contextId. A ausência do painel fechado não constitui divergência. Reabertura com outro telefone/grupo ou painel ilegível bloqueia; mudanças de contexto, conta, root/título, opt-in, lease ou texto continuam bloqueando. Evidência de progresso é a identidade conferida, não inferência por nome. Se fechar o painel invalida um vínculo manual, exigir contexto local atual na mesma conversa antes de continuar. Prova não é persistida como autorização reutilizável e não permite retry.

Telefone é canônico internacional: remover apenas formatação permitida (espaços Unicode, parênteses e hífens), comparar todos os dígitos com DDI; não acrescentar/remover dígitos nem aceitar letras/texto arbitrário ou número parcial. O formato externo canônico +DDI é preservado para compatibilidade da API/SQLite.

### Seleção acionável do resultado — 2026-10-19

Resultado único de contato deve ser acionado dentro de sua própria célula/controle (gridcell/button), focando esse controle e propagando um único gesto DOM comum de pointer/mouse a partir do conteúdo do resultado. click isolado não gera eventos de pressionamento usados por algumas listas. Não acessar handlers privados, não simular isTrusted, não selecionar globalmente o primeiro resultado nem repetir envio. Se houver rerender que desconecte o alvo, interromper o restante do gesto e aguardar a confirmação do cabeçalho; sem confirmação, falhar. Nomes não incluem badge de não lidas; nome renderizado é lido no span identificado quando disponível. Perfil/telefone exato continuam obrigatórios. Eventos CHAT_OPEN_STARTED/CHAT_OPENED distinguem acionamento e confirmação de abertura, sem dados privados.
