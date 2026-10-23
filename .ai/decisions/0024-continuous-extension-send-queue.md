# ADR0024 — Fila de envio contínua da extensão

Data: 2026-10-22. Estado: Accepted.

Desenho aprovado: `.ai/plans/2026-10-22-extension-send-queue-design.md`.

## Contexto

O envio pela extensão (`extension-send`) tinha pontos que prendiam ou quebravam a fila: o modo SUPERVISED esperava o clique do usuário por até a duração do lease (180 s); pedidos em `REQUESTED` expiravam em 300 s; a busca lateral e a gaveta "Nova conversa" não eram devolvidas ao estado inicial de forma confiável; busca preenchida, gaveta aberta ou rascunho existente faziam o pedido falhar; lease expirado virava `FAILED` sem recolocar na fila; e a disponibilidade dependia de `setInterval` no service worker, sem `chrome.alarms`.

## Decisão

Evoluir o `extension-send` existente com uma fila durável no SQLite, de propriedade da Local API (abordagem A do desenho).

- **Fila e status por pedido.** Todo pedido entra em `QUEUED` e é atendido por `priority DESC, created_at, id`. Prioridade 1 = AUTO com contagem 0 s. Status e posição são consultáveis pela API, pelo MCP (sem conteúdo de mensagem) e pelo painel. Novos status: `WAITING_WHATSAPP` (sem aba/contexto utilizável; a fila inteira aguarda) e `DRAFTED` (terminal do SUPERVISED). `REQUESTED` e `WAITING_USER` permanecem no enum só para linhas antigas; a migration 017 (schema 17) converte `REQUESTED` pendente em `QUEUED`.
- **SUPERVISED vira "rascunho pronto".** Localiza e valida o contato, desfaz a busca, escreve o texto no campo e termina em `DRAFTED`, sem esperar o clique. A fila segue imediatamente.
- **AUTO** mantém os opt-ins atuais (painel, autorização explícita por pedido, opt-in do MCP): valida, escreve, aguarda a contagem, clica, confere evidência e termina `SENT` ou `UNKNOWN`.
- **Estado inicial.** Logo após validar o contato, busca vazia e gavetas ("Nova conversa", perfil) fechadas; o contato alvo permanece aberto. No início de cada pedido a extensão normaliza a tela (limpa busca, fecha gavetas, apaga o campo de mensagem) em vez de falhar.
- **Junção de rascunho.** Se o mesmo alvo tem um pedido `DRAFTED` anterior e o campo ainda contém texto, a nova mensagem é acrescentada em nova linha, preservando o texto existente (inclusive editado pelo usuário). Idempotência por linha: o texto já presente apenas se for igual ao anterior ou terminar em `\n` + texto (R8).
- **R7 — AUTO com rascunho pendente no mesmo alvo.** O pedido falha com `DRAFT_PENDING_ON_TARGET` antes de tocar no campo: enviar o rascunho combinado enviaria conteúdo não autorizado, e substituí-lo destruiria o rascunho do usuário.
- **Tempos configuráveis** (tabela de configurações na API, painel da extensão, sobrescrita por pedido via API/MCP; valor fora da faixa é rejeitado, nunca ajustado): contagem AUTO 5 s (0–30 s); execução 60 s (20–180 s); espera máxima na fila 30 min (1 min–24 h ou sem limite); conferência pós-envio 15 s (5–60 s). O MCP não altera as configurações.
- **Disponibilidade.** `chrome.alarms` mantém o ciclo de poll e a reconexão. Ao reconectar, a extensão informa que não há job ativo; a API recoloca na fila jobs órfãos anteriores a `SENDING` (incrementa `attempts`, mantém `created_at`), pausa a fila até a extensão relatar `READY`, e marca `SENDING` órfão como `UNKNOWN` (nunca reenviado).
- Sem aba do WhatsApp, a extensão não abre aba: pedidos ficam `WAITING_WHATSAPP`.

## Alternativas consideradas

- **B. Fila em `chrome.storage` da extensão:** rejeitada; perde durabilidade, o MCP não enxerga o status real e contraria a posse do banco pela API (ADR 0002).
- **C. Migrar para o `outbox-engine` simulado:** rejeitada; é sintético, exigiria reescrever a operação da interface e descartaria o fluxo que já funciona.

## Consequências

- **Perda do rastreio de envio manual supervisionado.** O pedido termina em `DRAFTED`; a aplicação não sabe se o usuário enviou depois o rascunho. O acompanhamento do clique manual foi removido, junto com os cenários de teste correspondentes.
- **Pausa/requeue sem limite.** Pedido interrompido volta à fila sem limite de tentativas e a fila inteira pausa até `READY`. Um pedido que derruba repetidamente a aba pode pausar a fila indefinidamente; não há contador que o descarte. O cancelamento manual (API, MCP, painel) é a saída.
- **Limpeza destrutiva no início do pedido.** A normalização apaga texto digitado pelo usuário no campo de busca e texto alheio no campo de mensagem (exceto a junção de rascunho `DRAFTED` do mesmo alvo). Cenários de rascunho sem pedido `DRAFTED` correspondente são sobrescritos silenciosamente; se o relatório de `DRAFTED` falhar, um rascunho pode permanecer para um pedido `FAILED`.
- AUTO para um contato com rascunho pendente não é atendido (`DRAFT_PENDING_ON_TARGET`).
- A expiração conta a partir de `created_at`, inclusive em `WAITING_WHATSAPP` e após requeue.
- **Não verificado no WhatsApp real** (apenas em simulação Playwright): o seletor de fechamento da gaveta "Nova conversa" e a quebra de linha por `insertLineBreak`. Se o composer real renderizar a quebra como `<p>`, a verificação da junção falha de forma segura (o pedido falha, sem enviar). Validar em conta real é uma atividade manual separada, fora dos testes automatizados.
- Contrato novo: migration aditiva 017, `timing` e `appendToDraft` nos comandos, operações de gestão `SEND_*`, fase `DRAFTED` no flow log.

## Evidências da implementação

Ver a matriz de aceitação e os resultados das suítes em `.ai/context/current-state.md`.
