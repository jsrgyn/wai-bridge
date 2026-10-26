# Busca por telefone e reinício dos serviços — análise e plano

- Data: 2026-10-26
- Base: main 428fb90 (PR #2 mesclado)
- Status: diagnóstico concluído; parte A implementada e testada (`SEARCH_STRUCTURE`, `waiSearchDiagnostics` com 3 relatórios, botão "Diagnosticar busca" no painel); partes B e D aguardam o relatório real

## 1. Sintomas relatados

1. Pedidos de envio pelo número ficam `CLAIMED`, o contato é encontrado no WhatsApp mas não fica selecionado e o campo de mensagem continua vazio.
2. `scripts/restart-local-services.sh` parou no passo 5 com "não foi possível ler a versão do schema".
3. `scripts/restart-local-services.sh --check` respondeu "Uso:" quando recebeu o comentário colado junto com o comando.

## 2. Evidências (logs e banco, sem conteúdo de mensagens)

| Fato | Evidência |
|---|---|
| Todos os 5 pedidos de hoje falharam com `PHONE_CONTACT_NOT_FOUND`, sempre a 16,2 s após `RECIPIENT_LOOKUP`. | `wa_flow_logs` e `wa_outbox` |
| 16,2 s = 8 s de espera na barra lateral + 8 s de espera na gaveta "Nova conversa", sem nenhuma linha de resultado reconhecida nas duas. | `findCandidate` em `phone-search.ts` (timeout de 8000 ms) |
| A aba estava visível durante a busca. A verificação `gate` roda a cada volta da espera e lançaria `WHATSAPP_TAB_NOT_VISIBLE` se a aba estivesse oculta. | `visible-send.ts` `gate()`; o erro registrado não é esse |
| Envios anteriores funcionaram (confirmados em 19 e 20/10 com `VISIBLE_OUTBOUND_CONFIRMED`). | `wa_outbox` agrupado por dia |
| O código que monta o campo de busca não mudou de forma relevante desde então (`write()` idêntico). | `git diff 85bb0fb HEAD -- phone-search.ts` |
| Erro de schema no passo 5: o `sqlite3` roda com `2>/dev/null`, então a causa real some. | `schema_version()` em `restart-local-services.sh` |
| `--check` rejeitou argumentos extras: o comentário "# deve sair…" foi colado junto com o comando. | comportamento correto do parser; falha de uso |

## 3. Hipóteses

- **H1 (mais provável, não confirmada):** o WhatsApp Web mudou a estrutura dos resultados de busca (testids ou contêineres das linhas), e `candidateRows()` não encontra mais as linhas. Compatível com 16,2 s uniforme e com o contato aparecer para o usuário.
- **H2 descartada:** aba oculta. A verificação de visibilidade não disparou.
- **H3 descartada:** mudança no `write()` do campo. O código é o mesmo.
- **H4 (a confirmar):** o campo de busca não aceita a escrita para este número (formato do número). Só o diagnóstico confirma.
- **Schema (passo 5):** provável contenção do banco logo após o reinício, quando a API ainda aplica migrações. Não confirmada, porque o erro foi descartado.

## 4. Plano

### Parte A — Diagnóstico estrutural da busca (sem mudar o comportamento de envio)
- Content script: nova mensagem `SEARCH_STRUCTURE` que devolve **somente estrutura**: contagens de `cell-frame-container`, linhas visíveis, `role` listitem/row/gridcell/heading, `aria-busy`, presença do campo de busca e da gaveta, e a lista de `data-testid` distintos (máximo 40). Nunca texto, nunca valores de atributo além de testids.
- Background: ao falhar com `PHONE_CONTACT_NOT_FOUND`, guarda o último relatório em `chrome.storage.local` (limite de 3, sem conteúdo).
- Painel: botão "Diagnosticar busca" que pede ao content script um relatório da aba aberta (somente leitura, sem digitar nem clicar) e mostra o resultado; mostra também o último relatório de falha.
- Testes: e2e com página sintética que tem a estrutura conhecida; asserção de que o relatório não contém texto nem telefone.

### Parte B — Correção da detecção de resultados (depois da evidência da Parte A)
- Ajustar `candidateRows()` e os testids conforme o relatório real, com fallback por estrutura.
- Separar os códigos de falha: `SEARCH_NO_RESULT_ROWS`, `SEARCH_ROWS_UNRECOGNIZED`, `PHONE_CONTACT_NOT_FOUND` (somente quando há linhas e nenhuma corresponde).
- Fixtures sintéticas com a nova estrutura; teste que falha antes da mudança.

### Parte C — Reinício seguro (scripts/restart-local-services.sh)
- Não descartar o erro do `sqlite3`: capturar e mostrar a mensagem.
- Tentar a leitura do schema por até 20 s com `-cmd '.timeout 5000'`, aguardando a API terminar as migrações.
- Mensagem clara quando o `--check` recebe argumentos extras, sugerindo colar só o comando.
- Testes: banco bloqueado por uma transação durante 3 s → o script aguarda e confirma o schema; sem bloqueio → comportamento atual.

### Parte D — Operação
- Depois da Parte A, o usuário roda "Diagnosticar busca" com o número digitado manualmente na barra de busca do WhatsApp (sem enviar nada) e me envia o relatório de estrutura.

## 5. Ordem e critérios de aceitação

1. Parte C (concreta, testável) e Parte A (diagnóstico) nesta rodada.
2. Parte B só depois do relatório real.
3. Critério geral: `pnpm build && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration`, e2e de busca e painel por caminho.
4. Nada de conteúdo de mensagem, telefone ou nome em logs, storage ou relatórios.
