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
