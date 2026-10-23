# Desenho: fila de envio contínua, retorno ao estado inicial e disponibilidade da extensão

- Data: 2026-10-22
- Status: aprovado em 2026-10-22
- Abordagem escolhida: A (evoluir o `extension-send` atual com fila no SQLite da Local API)
- ADR a criar na implementação: 0024

## 1. Intenção

Tornar o envio pela extensão fluido e previsível: todo pedido de envio (supervisionado ou automático) entra numa fila, é atendido em ordem e tem um status individual consultável. A extensão sempre devolve o WhatsApp Web a um estado inicial limpo depois de usar a busca, nunca prende a fila esperando o usuário e se recupera sozinha de quedas.

Hoje (verificado no código):

- SUPERVISED preenche o campo e aguarda o clique do usuário por até a duração do lease (180 s), prendendo a fila (`apps/chrome-extension/src/commands/visible-send.ts`, `waitForManualSend`).
- Pedidos em `REQUESTED` expiram após 300 s como `FAILED/REQUEST_EXPIRED` (`packages/database/src/repositories/extension-send.ts`).
- A busca só é limpa no `finally` do job, sob condições; a gaveta "Nova conversa" nunca é fechada (`phone-search.ts`, `release()`).
- Busca preenchida, gaveta aberta ou rascunho existente fazem o pedido falhar (`SEARCH_HAS_INPUT`, `COMPOSER_HAS_DRAFT`).
- Lease expirado vira `FAILED` (ou `UNKNOWN` se já em `SENDING`), sem recolocar na fila.
- Disponibilidade depende de `setInterval` no service worker e da porta nativa; não há `chrome.alarms`.

## 2. Objetivos

1. **Fila com status por pedido.** Todo pedido entra na fila e recebe status individual; posição na fila é consultável pela API e pelo MCP.
2. **Supervisionado vira "rascunho pronto".** Localiza e valida o contato, desfaz a busca, escreve a mensagem no campo e encerra com status terminal `DRAFTED`. O contato fica aberto; o WhatsApp mantém o rascunho. A fila segue imediatamente. Não há mais espera pelo clique do usuário.
3. **Automático.** Localiza, valida, desfaz a busca, escreve, aguarda a contagem configurada, envia, confere evidência visível e encerra `SENT` (ou `UNKNOWN`). Contato fica aberto; busca limpa.
4. **Retorno ao estado inicial.** Logo após validar o contato: campo de busca vazio e gavetas ("Nova conversa", perfil) fechadas. O contato alvo permanece aberto.
5. **Normalizar em vez de falhar.** Ao iniciar um pedido, a extensão limpa a busca, fecha gavetas e apaga texto do campo de mensagem (decisão do usuário: "apagar e seguir"), com a exceção do item 6.
6. **Junção de rascunhos.** Se o contato alvo tem um pedido `DRAFTED` anterior e o campo ainda contém texto, a nova mensagem é acrescentada ao final, em nova linha, preservando o texto existente mesmo que o usuário o tenha editado.
7. **Configurador de tempos** no painel da extensão, persistido na Local API, com padrão e faixa; API e MCP podem informar valores por pedido dentro da faixa.
8. **Disponibilidade.** `chrome.alarms` mantém o ciclo de despertar; reconexão automática ao agente macOS; pedido interrompido antes do clique em Enviar volta para a fila; interrompido depois vira `UNKNOWN` (não reenviado).
9. **Sem aba do WhatsApp Web:** a extensão não abre aba; pedidos ficam com status `WAITING_WHATSAPP` até o usuário abrir.

## 3. Não objetivos

- Envio em paralelo; continua um envio por vez na interface (lease singleton).
- Reenviar automaticamente pedidos `UNKNOWN` (risco de duplicar mensagem).
- Rastrear se o usuário enviou depois um rascunho `DRAFTED` (o pedido termina em `DRAFTED`).
- Abrir ou recarregar abas do WhatsApp Web automaticamente.
- Captura de histórico, antidetecção, interceptação de protocolo ou acesso a credenciais de sessão.

## 4. Anti-objetivos (falha mesmo funcionando)

- Mensagem duplicada para um contato.
- Envio para contato diferente do validado.
- Rascunho de pedido anterior perdido sem ser pedido.
- Conteúdo de mensagem em logs, eventos ou status.

## 5. Restrições

- Local API é a única dona do SQLite; migration aditiva (schema 17).
- Contratos com Zod em `packages/shared`; TypeScript strict.
- Testes com dados sintéticos e WhatsApp simulado (Playwright); nenhum envio real.
- AUTO continua exigindo os opt-ins atuais (painel, autorização explícita por pedido e opt-in do MCP).
- Repositório público: nenhum dado real em fixtures, logs ou documentos.

## 6. Abordagens consideradas

- **A. Evoluir `extension-send` com fila no SQLite da API (escolhida).** Respeita a posse do banco pela API (ADR 0002), aproveita testes e fluxo existentes; exige migration e mudanças em banco, API, extensão e MCP.
- **B. Fila dentro da extensão (`chrome.storage`).** Descartada: perde durabilidade, MCP não vê status real, contraria a arquitetura.
- **C. Migrar para o `outbox-engine` simulado.** Descartada: é sintético, exigiria reescrita para operar a interface e descartaria o fluxo que já funciona.

## 7. Decisões do usuário

- Abordagem A, implementada em três etapas nesta ordem: (1) fila e status; (2) estado inicial, modo rascunho e junção; (3) disponibilidade e configurador.
- Tela "suja" no início de um pedido: apagar e seguir.
- Rascunho anterior do mesmo contato: juntar as duas mensagens no mesmo rascunho.
- Supervisionado não espera mais o clique do usuário.
- Tempos configuráveis no painel; API e MCP podem sobrescrever por pedido.
- Despertador do Chrome (`chrome.alarms`); reconexão automática; requeue antes do clique; `UNKNOWN` após o clique.
- Sem aba do WhatsApp: indisponível, status "aguardando WhatsApp"; não abrir aba.
- Rascunho editado pelo usuário: preservar o que foi digitado e acrescentar a nova mensagem no final.
- Pedido interrompido: volta para a fila sem limite de tentativas; a fila inteira pausa até a extensão relatar que normalizou (`READY`) e então retoma.
- Contagem 0 s no automático é permitida por pedido; pedido com contagem 0 ganha prioridade e passa à frente na fila.

## 8. Ciclo de vida do pedido

Estados (os existentes em `OutboxStatusSchema` mais os novos marcados com *):

| Status | Significado | Terminal |
|---|---|---|
| `QUEUED` | Na fila, aguardando sua vez (substitui o uso de `REQUESTED` para "em espera") | não |
| `WAITING_WHATSAPP`* | Na fila, mas sem aba/contexto do WhatsApp disponível | não |
| `CLAIMED` → `TARGET_VERIFIED` → `COMPOSED` | Em execução | não |
| `WAITING_AUTO_SEND` | Contagem antes do envio automático | não |
| `SENDING` | Clique em Enviar registrado | não |
| `DRAFTED`* | Supervisionado concluído: rascunho pronto no contato | sim |
| `SENT` | Automático com evidência visível | sim |
| `UNKNOWN` | Interrompido após o clique; não reenviar | sim |
| `FAILED` | Erro com motivo enumerado (ex.: contato não encontrado, ambíguo, expirado na fila) | sim |
| `CANCELLED` | Cancelado pelo usuário/cliente | sim |

Regras:

- Ordem da fila: pedidos prioritários (AUTO com contagem 0 s) primeiro; dentro de cada grupo, por `created_at`.
- Interrupção (lease expirado, aba recarregada, porta caída) antes de `SENDING` → volta para `QUEUED`, incrementa `attempts`, mantém a posição original. Sem limite de tentativas.
- Após uma interrupção, a fila fica pausada (nenhum novo claim) até a extensão relatar `READY` depois de reconectar/recarregar; então retoma pelo mesmo pedido.
- "Mesmo alvo" (para junção de rascunho) = mesma referência de conversa confirmada, ou mesmo telefone normalizado quando não houver referência. *(decisão do agente)*
- Tempo máximo de espera conta a partir de `created_at`, inclusive durante `WAITING_WHATSAPP` e após requeue. *(decisão do agente)*
- Migration converte linhas `REQUESTED` pendentes em `QUEUED`; a API continua aceitando leitura de `REQUESTED` em linhas antigas. *(decisão do agente)*
- `WAITING_WHATSAPP` e a pausa valem para a fila inteira, pois há um único lease de interface. *(decisão do agente)*
- Cancelamento: permitido pela API, MCP e painel em `QUEUED`, `WAITING_WHATSAPP`, `CLAIMED`, `TARGET_VERIFIED`, `COMPOSED` e `WAITING_AUTO_SEND` (interrompe a contagem); não permitido a partir de `SENDING`. *(decisão do agente)*
- Interrupção em `SENDING` → `UNKNOWN`.
- `WAITING_WHATSAPP` é atualizado pela API conforme o estado de prontidão relatado pela extensão (`NO_WHATSAPP_TAB`, `CONTENT_UNREACHABLE` etc.) e volta a `QUEUED` quando a extensão fica `READY`.
- Expiração na fila só ocorre se o tempo máximo de espera configurado não for "sem limite".
- `WAITING_USER` deixa de ser usado no novo fluxo; permanece no enum por compatibilidade com linhas antigas.

## 9. Fluxo na interface (por pedido)

1. **Normalizar:** limpar busca da barra lateral, fechar gaveta "Nova conversa" e perfil, se abertos.
2. **Localizar e validar** contato (fluxo atual de `phone-search` / referência confirmada).
3. **Retornar ao estado inicial:** limpar busca e fechar gavetas imediatamente após a validação; contato alvo segue aberto.
4. **Preparar o campo:**
   - se a API indicar que existe pedido `DRAFTED` anterior para o mesmo alvo e o campo contém texto, acrescentar a nova mensagem ao final, em nova linha, sem alterar o texto existente;
   - caso contrário, apagar o conteúdo do campo e escrever a nova mensagem.
5. **Revalidar** o contato aberto (verificação atual antes de compor/enviar).
6. **SUPERVISED:** marcar `DRAFTED` e liberar a fila.
   **AUTO:** contagem configurada → `SENDING` → clique → conferência de evidência → `SENT`/`UNKNOWN`.
7. Liberar o lease; o próximo pedido começa.

## 10. Configurador de tempos

Persistido na Local API (nova tabela de configurações), lido pela extensão e validado pela API. Editável no painel da extensão.

| Parâmetro | Padrão | Faixa |
|---|---|---|
| Contagem antes do envio automático | 5 s | 0–30 s |
| Tempo máximo de uma execução | 60 s | 20–180 s |
| Tempo máximo de espera na fila | 30 min | 1 min–24 h, ou sem limite |
| Tempo de conferência após enviar | 15 s | 5–60 s |

- API e MCP aceitam valores por pedido para esses parâmetros; valores fora da faixa são rejeitados com erro de validação (não ajustados silenciosamente). *(decisão do agente)*
- Contagem 0 s por pedido é permitida com os opt-ins atuais e torna o pedido prioritário.
- Alterações valem para pedidos que ainda não começaram a executar.

## 11. Status consultável

- API: consulta de um pedido por ID com status, motivo, tentativas e posição na fila; listagem da fila ativa.
- MCP: ferramenta de status por pedido e da fila, sem conteúdo de mensagem.
- Painel da extensão: lista da fila com status e posição.

## 12. Disponibilidade

- `chrome.alarms` (permissão `alarms` no manifest) dispara o ciclo de poll/reconexão mesmo após o service worker ser suspenso; o poll rápido atual continua enquanto o worker está ativo.
- Reconexão automática da porta nativa com backoff (já existe; passa a ser também acionada pelo alarme).
- Ao reconectar, a extensão informa à API que não há job ativo; a API recoloca na fila jobs `CLAIMED`/`TARGET_VERIFIED`/`COMPOSED`/`WAITING_AUTO_SEND` órfãos e marca `SENDING` órfão como `UNKNOWN`.

## 13. Critérios de aceitação (alto nível)

1. Dois ou mais pedidos simultâneos são todos atendidos em ordem de criação, cada um com status final.
2. Pedido supervisionado termina em `DRAFTED` sem interação do usuário; a fila prossegue.
3. Após validar o contato, busca vazia e gavetas fechadas; contato alvo aberto.
4. Busca preenchida, gaveta aberta ou texto no campo no início do pedido não causam falha.
5. Segundo pedido supervisionado ao mesmo contato acrescenta ao rascunho anterior.
6. Sem aba do WhatsApp, pedidos ficam `WAITING_WHATSAPP` e são atendidos quando a aba aparece.
7. Recarregar a aba no meio de um pedido antes do envio o recoloca na fila, pausa a fila até `READY` e ele é concluído; durante `SENDING`, termina `UNKNOWN` e não é reenviado.
10. Rascunho editado pelo usuário é preservado e a nova mensagem é acrescentada ao final.
11. Pedido AUTO com contagem 0 s passa à frente dos demais na fila.
8. Tempos do painel são persistidos e respeitados; sobrescrita por pedido fora da faixa é rejeitada.
9. `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration` e a suíte Playwright da extensão passam; nenhum envio real.

## 14. Deixado ao construtor

- Nomes de tabelas, colunas, rotas e ferramentas MCP, seguindo os padrões do repositório.
- Forma de inserir a quebra de linha no campo do WhatsApp simulado/real.
- Intervalo do alarme (mínimo permitido pelo Chrome).
- Divisão dos commits dentro de cada etapa.
