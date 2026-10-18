# ADR 0009: User-confirmed phone and local group references

- Date: 2026-10-18
- Status: Accepted for experimental local observation

## Context

ADR 0008 deliberately fragments conversations because visible labels are not IDs.
Manual UI inspection found a complete international phone in Contact info, but no
contact identity attributes in the inspected header. No supported stable group ID
has been demonstrated. The user requested phone association and a group solution.

## Decision

Keep UUIDs internally. A user selects a locally registered account and explicitly
confirms the open conversation in the extension popup. Phone references come only
from a unique, standalone international phone visible in Contact info; normalization
removes formatting but never guesses country/area digits. Groups use a locally
generated UUID, explicitly created or reselected by the user. Display labels never
select or merge groups. Local account IDs are declarations, not extracted sessions.

An optional versioned identity envelope accompanies MESSAGE observations through
the existing Native Messaging/API path. The API keys conversations by local
account + reference type + reference value and allocates sequence transactionally.
Direct phone contacts are PARTIAL; local group references remain PARTIAL and group
members are not merged by names. Neither method enables sending or asserts an
official WhatsApp group ID. Sender on outbound remains null.

The live confirmation is in content-script memory only. Preview issues a context
token. Binding rechecks the same DOM root/header and visible evidence. Navigation,
header mutation/replacement, page hide, and interactions outside the composer
invalidate confirmation. Pending DOM mutations are flushed before attaching identity
to a new observation. Closing/reloading/stopping monitoring requires reconfirmation.
No automatic profile opening, account discovery, invitation-link collection, app
state access or private protocol is added. No existing history is relinked.

## Consequences and limits

Incoming messages can share a conversation when current confirmation remains valid.
An unknown or changed context falls back to ADR 0008. Group mapping survives rename
through its local UUID, but the user must reselect it when reopening the conversation.
Choosing the wrong account/group is possible; confirmation is local evidence, not
cryptographic proof. A UI change with no observable navigation/header signal cannot
be ruled out; real compatibility remains experimental. Conservative invalidation
can require frequent confirmations, including on some status changes.

Migration 008 allows many observations per conversation and adds reference metadata.
Earlier normalization records are preserved. Query provenance on a conversation uses
one representative observation; messages retain their individual source IDs. Browser
local account/group choices must be backed up independently; reusing a local group
UUID restores the same mapping, while reinstalling without those choices does not
magically rediscover it. No hash of names, photos, recados or participant lists is used.

## Ajuste verificado em 2026-10-18 — diálogo bidirecional

A confirmação agora permite interação com o botão Enviar (aria-label Enviar/Send,
button ou role=button) dentro do footer da mesma raiz. Isso apenas conserva o
contexto durante envio manual; não aciona envios nem altera o outbox. Cabeçalhos
com conversation-info-header-chat-title invalidam pelo título/raiz/cabeçalho
removido, mantendo o vínculo em mudanças de presença no subtítulo. Cabeçalhos
sem título reconhecido mantêm invalidação por qualquer mutação de cabeçalho.
Demais controles de contexto/proveniência permanecem. Consulta MCP de diálogo
usa as rotas de leitura existentes e expõe ambas as direções, paginadas por
sequência, sem unir UNKNOWN por nome nem alterar estado de leitura.
