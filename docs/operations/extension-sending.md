# Envio pela extensão WAI Bridge

O fluxo experimental é IA/MCP → Local API/outbox SQLite → agente nativo → extensão
→ interface da conversa aberta. O agente de IA não usa automação externa do Chrome.
A resolução por nome ocorre no SQLite pela API; a interface é conferida pelo telefone. Não há uso de APIs privadas. A opção locateByPhone permite
navegação pontual pela busca visível de um contato individual.

## Pedido por nome cadastrado

Use `whatsapp_send_to_contact` com `recipientName`, `text`, `mode`,
`explicitAuthorization:true` e `idempotencyKey`. A API procura na conta ativa:
primeiro nome exato sem diferenciar maiúsculas/acentos, depois trecho. Todos os
resultados precisam apontar para um único telefone. “Esposa” corresponde ao nome
cadastrado, não a parentesco deduzido. `AMBIGUOUS_RECIPIENT`,
`RECIPIENT_NAME_NOT_FOUND` ou `RECIPIENT_PHONE_REQUIRED` pedem identificação explícita.
A IA deve pedir o número completo e usar `whatsapp_send_to_number` quando necessário.

O retorno inicial só confirma intenção persistida. A extensão pesquisa/confronta o
telefone, registra a identidade observada na API e prepara a mensagem. Em
SUPERVISED o pedido termina em `DRAFTED` (rascunho pronto, sem clicar Enviar); em
AUTO há uma contagem cancelável configurável (padrão 5 s, 0–30 s). Sem prova, nenhum
envio. `UNKNOWN` não permite repetição. Veja a seção Fila, tempos e rascunhos.

## Pedido direto: número e mensagem

Use `whatsapp_send_to_number` para informar `phoneNumber` internacional com DDI,
`text`, modo e autorização explícita, sem conversationId e sem cadastro prévio do
destinatário no SQLite. A IA gera a idempotencyKey para o pedido. SUPERVISED é o
padrão; para envio automático autorizado, use AUTO.

```json
{
  "phoneNumber": "+12025550199",
  "text": "Mensagem sintética de exemplo",
  "mode": "AUTO",
  "explicitAuthorization": true,
  "idempotencyKey": "<CHAVE_IDEMPOTENCIA_SINTETICA>"
}
```

O número acima é sintético, não um destinatário para teste real. O pedido é
persistido antes da busca. A API não cria um contato/conversa confirmados apenas
porque um número foi informado. A extensão deve encontrar um único resultado
visível e comprovar o telefone completo no perfil antes de compor e enviar. Se não aparecer nas conversas, pesquisa também o diretório visível de Nova conversa. Nome/telefone conferidos são registrados no SQLite antes de DRAFTED/WAITING_AUTO_SEND (e, portanto, antes de SENDING); isso não cria contato na agenda do celular.
Se não houver resultado acessível, falha sem usar protocolo privado ou outro canal.

Com apenas uma conta local ativa e autorizada, accountId é dispensável. Com várias,
indique accountId; a API não escolhe silenciosamente. Atividade vem de poll nativo
com opt-in nos últimos 15 segundos, persistido em wa_sync_state com escopo próprio.
Monitor ON, permissão de envio e aba ativa com uma conversa identificada continuam
necessários. Ausência de conta ativa retorna ACTIVE_SEND_ACCOUNT_REQUIRED;
ambiguidade retorna AMBIGUOUS_SEND_ACCOUNT. Aguarde o poll após ativar/reconectar.

Repetir a mesma chave e o mesmo pedido normalizado devolve o comando anterior,
mesmo depois que o contexto expira. Outra mensagem/número/conta explícita com a
mesma chave gera conflito. QUEUED não confirma envio; consultar status até
DRAFTED/SENT/FAILED/CANCELLED/UNKNOWN. UNKNOWN nunca autoriza repetição automática.

## Busca e conferência pelo número cadastrado

Em `whatsapp_send_message`, informe `locateByPhone:true` para localizar o contato
individual registrado, mesmo com outra conversa aberta na mesma conta local. A API
exige telefone normalizado no cadastro e copia esse número para o comando; não
aceita inventar número a partir do nome. Localize a conversa por `contactPhone` em
`whatsapp_list_conversations` e use seu UUID. Exemplo de pedido:

```json
{
  "conversationId": "<UUID cadastrado>",
  "locateByPhone": true,
  "text": "Mensagem autorizada pelo usuário",
  "mode": "AUTO",
  "explicitAuthorization": true,
  "idempotencyKey": "<chave única com pelo menos 16 caracteres>"
}
```

A extensão preenche o campo de pesquisa, exige um resultado visível, abre a conversa
e o perfil, e compara o telefone internacional completo. Resultado filtrado, nome
ou foto não confirmam identidade. Antes de compor e de enviar, revalida o telefone,
conta local, contexto/raiz e texto. SUPERVISED termina em DRAFTED; AUTO mantém a contagem e a confirmação SENDING.

É preciso monitor ON, permissão de envio, aba WhatsApp ativa com uma conversa
identificada na conta correta. A busca é limpa pela própria extensão no início
(texto digitado ali pelo usuário é apagado). Se já houver
um perfil aberto, a extensão o fecha pelo botão visível antes da busca; painel
em edição ou sem controle inequívoco de fechamento bloqueia a operação. Não há busca automática em grupos ou contato sem telefone cadastrado.
Busca ocupada, zero/vários resultados, perfil indisponível, telefone diferente,
grupos, troca de conta ou interferência do usuário bloqueiam sem clicar Enviar.
Abertura de conversa pode mudar o indicador de não lidas do WhatsApp, sem ACK de IA.

Ao terminar, limpa apenas a consulta que a própria extensão escreveu, se ela
permanecer inalterada e não tiver havido intervenção/cancelamento. Não apaga texto
do usuário. O perfil permanece aberto para conferência. Pode surgir nova referência
UI_CONTEXT após navegação; o pedido por telefone passa a registrar o UUID da conversa efetivamente conferida. Não há
promessa de consolidar automaticamente históricos fragmentados.

Sem locateByPhone, permanece o envio para a conversa aberta com referência exata.
Essa navegação é um recurso de envio pontual, não captura global (FR-13).

## Ativação do envio na conversa já aberta

1. Atualize/build, recarregue a extensão e a aba WhatsApp. Inicie o monitor.
2. Com monitor ON, a conta local e a conversa aberta são identificadas automaticamente.
   O vínculo manual permanece opcional. Para busca por telefone, a própria extensão
   abre o perfil e confere o destinatário; nome/foto sozinhos não autorizam envio.
3. Marque **Permitir comandos de envio do MCP nesta extensão** no popup.
4. No inicializador MCP privado, defina `WAI_MCP_ALLOW_EXTENSION_SENDS=true`, mantendo
   `WAI_MCP_ALLOW_WRITES=false` para os comandos legados. Reconecte Codex/Claude.
   A instalação local deste usuário pode já ter essa variável configurada; confira
   o estado documentado, sem imprimir tokens/configuração privada.
5. Deixe a aba WhatsApp ativa e o painel de dados aberto.

A ferramenta `whatsapp_send_message` recebe:

```json
{
  "conversationId": "<UUID da conversa vinculada>",
  "text": "Mensagem autorizada pelo usuário",
  "mode": "AUTO",
  "explicitAuthorization": true,
  "idempotencyKey": "<chave única com pelo menos 16 caracteres>"
}
```

SUPERVISED é o padrão: prepara o texto no campo da conversa conferida e termina em
`DRAFTED`, sem clicar Enviar; a fila segue. AUTO aguarda a contagem configurada
(cancelável na página), revalida contexto/texto e só clica depois que o SQLite
confirma SENDING. Não solicita nem amplia autorização pelo conteúdo recebido.

O retorno inicial é um ID QUEUED, não confirmação de envio. Consulte
`whatsapp_get_outbox_status` com esse ID. SENT exige uma bolha de saída nova,
texto exato e status visível Enviado/Entregue/Lido (ou equivalente inglês). Isso
comprova apenas o que foi observado na UI, não uma confirmação de protocolo oficial.
Resultado incerto vira UNKNOWN: não reenviar automaticamente. A captura normal
registra a mensagem de saída e o diálogo continua disponível pelo MCP.

## Cancelamento e limites

Use o botão Cancelar envio WAI Bridge durante a espera, ou
`whatsapp_cancel_extension_send({id})` antes de SENDING. Desmarcar a permissão
interrompe preparação/espera. Depois de SENDING não é possível desfazer o efeito.

Em falha pré-envio, o texto preparado pode permanecer no campo para revisão.
Mudança de conversa, aba oculta, vínculo inválido, opt-in revogado ou estrutura
ambígua impedem o clique. Se a lease de execução expirar após SENDING, fica UNKNOWN
sem retry. A expiração na fila segue o tempo máximo configurado (ver abaixo).
Comandos legados `send` continuam separados e simulados.

Cada confirmação é válida para a janela/contexto atual. Não reutilize um grupo
local para outro grupo. Nomes, fotos e participantes não autorizam destinatários.
Compatibilidade com o DOM real permanece experimental; testes automatizados usam
somente páginas e dados sintéticos. Não foi realizado envio real por este novo fluxo.

## Aba oculta e perfil aberto

O poll registra a conta autorizada mesmo quando a aba selecionada está oculta, mas
só reivindica pedidos quando ela estiver visível. Após solicitar pelo MCP, volte ao
Chrome/WhatsApp para começar; enquanto isso a fila fica em WAITING_WHATSAPP. Se a visibilidade
mudar entre claim e preparação, o executor aguarda dentro da lease; durante envio,
ocultar bloqueia novas ações (`WHATSAPP_TAB_NOT_VISIBLE`). Outros gates distinguem
`EXTENSION_SENDS_DISABLED` e `SEND_LEASE_EXPIRED`. Com um pedido explícito pendente e opt-in, uma única aba compatível do WhatsApp pode ser ativada automaticamente (ADR0015); nenhum foco muda quando não há pedido.
Checkbox de notificações, controles ocultos e busca no perfil não impedem fechá-lo;
campos de edição de texto visíveis continuam protegidos (`PROFILE_HAS_INPUT`).
Em SUPERVISED, o pedido já terminou em DRAFTED quando o rascunho fica pronto; o
envio manual posterior pelo usuário não é acompanhado pela aplicação.

Atualização exige build de todos os componentes, restart da API local e recarga da
extensão/WhatsApp. Reconecte MCP para descobrir `whatsapp_send_to_contact`. Clientes
antigos sem prova de perfil não podem completar novos pedidos por telefone.

### Resultados de pesquisa mistos

O WhatsApp pode mostrar Conversas, Grupos em comum e Mensagens ao pesquisar um
telefone. Apenas Conversas/Contatos (Chats/Contacts) entram na seleção; grupos em
comum e trechos de mensagens não são outros destinatários. Múltiplos candidatos
nessas seções ainda produzem AMBIGUOUS_PHONE_RESULTS, sem escolha pelo primeiro
nome. O telefone exato no perfil individual continua obrigatório. Lista antiga
que não concluiu atualização produz SEARCH_RESULTS_NOT_READY; não significa que
outro destinatário tenha sido identificado. Aguarda estabilidade/indicador busy.

## Resposta e diagnóstico do MCP (ADR 0015)

O background procura as abas existentes de WhatsApp, não somente a aba selecionada
na última janela. A cada segundo (e ao receber eventos de foco/visibilidade/opt-in),
consulta contextos com timeout de 1,5s. Preflight não reivindica comando. Somente
uma aba compatível e monitorada pode ser ativada por pedido autorizado; a execução
aguarda novo contexto visível. Várias abas compatíveis bloqueiam com AMBIGUOUS_TABS.
Monitor OFF e opt-out impedem execução. Ainda é necessário abrir uma conversa para
estabelecer a conta/contexto local após recarregar o WhatsApp.

SEND_EXECUTE confirma aceitação imediatamente. Durante a execução, o background
continua consultando o estado autenticado da mesma lease. Cancelamento no MCP aborta a espera local no
próximo poll. ACK perdido nunca causa nova execução. Sem resposta da aba, o timeout
libera a rotina de consulta, e um comando já reivindicado aguarda recuperação
persistente sem ser reenviado. Captura lenta no native host não bloqueia progresso.

`whatsapp_status` agora inclui `extension.native`, `bridge`, `ready`, `lastPollAt`,
`protocolVersion`, `build` e contagens da fila. O status geral ok descreve API/DB;
não confirma a ponte pronta. STALE significa poll antigo (>15s); CONTENT_UNREACHABLE
indica aba sem resposta; CONTENT_OUTDATED indica builds diferentes entre script e
background; NO_MONITORED_CONTEXT exige monitor ON e uma conversa aberta. READY com
protocolo 2 e build atual confirma contexto vivo, sem comprovar envio. Pedidos
antigos em WAITING_USER aparecem como COMPOSED. Não há contatos/texto/tokens no diagnóstico.

Perfil do destinatário já aberto com telefone exato é reutilizado antes de buscar;
continua verificando conta, rascunho e identidade. A contagem de AUTO segue o valor configurado,
sem permissão para enviar ocultamente. Consultar status/outbox não envia.

### Composição e COMPOSE_FAILED

A extensão insere o texto uma única vez e confere o conteúdo renderizado por até um segundo; retorno booleano de insertText não comprova sucesso/falha do editor. Texto ausente ou divergente bloqueia antes de SENDING. Não há segunda inserção. Após falha, confira o campo manualmente antes de novo pedido: pode existir texto preparado mesmo sem envio. Recarregue extensão e depois a aba para ativar novo build.

### Diagnóstico de abertura de perfil

`PHONE_CHAT_UNAVAILABLE`: título da conversa não correspondeu ao resultado selecionado no prazo. `PHONE_PROFILE_CONTROL_UNAVAILABLE`: controle visível e único de Dados do perfil/Profile details não encontrado. `PHONE_PROFILE_UNAVAILABLE`: painel não forneceu prova individual/nome correspondente/telefone exato no prazo (também preservado em esperas auxiliares do diretório/fechamento). Controles podem ser button HTML ou role=button. Perfil já verificado é reutilizado sem clique que o feche; telefone divergente e grupos continuam bloqueados. Esses erros não autorizam repetir envio automaticamente.

### Conferência com fechamento do perfil (2026-10-19)

A extensão confirma o número completo, fecha os dados pelo botão Fechar/Close e só depois prepara a mensagem. DRAFTED deve deixar o painel fechado, sem exigir reabertura manual. A prova fica limitada àquela execução/conversa; fechar não é divergência. Trocar conversa ou reabrir com outro número bloqueia. Espaços comuns/Unicode, parênteses e hífens não alteram a comparação; nenhum dígito é acrescentado/removido. Perfil com edição pendente ou Close indisponível bloqueia antes de compor.

Valide com um único pedido SUPERVISED: espere perfil abrir/fechar e o status DRAFTED, confirme o texto no campo e, se quiser, clique Enviar manualmente. Primeiro confira estado do pedido anterior; FAILED não deve ser repetido automaticamente. Ao trocar de conversa antes de enviar, o comando deve falhar sem clicar. Testes automatizados usam exclusivamente UI/dados sintéticos.

### Resultado encontrado, conversa não abre

PHONE_CHAT_UNAVAILABLE significa que o cabeçalho não confirmou a conversa selecionada. Logs CHAT_OPEN_STARTED e CHAT_OPENED distinguem acionamento e abertura confirmada; ausência do segundo indica bloqueio antes da conferência do perfil. O adaptador usa a célula acionável do resultado único e um gesto DOM de pressionamento/liberação/clique; não escolhe o primeiro resultado entre contatos ambíguos. Contador de não lidas é separado do nome. USER_INTERFERENCE informa interação durante a localização: aguarde o preparo sem clicar/digitar na busca. Nenhum desses erros autoriza replay automático do pedido.

## Fila, tempos e rascunhos (ADR 0024)

- **Fila.** Todo pedido entra em `QUEUED` e é atendido um por vez, por prioridade e
  ordem de criação. AUTO com contagem 0 s tem prioridade 1 e passa à frente dos que
  esperam, nunca do que está em execução. Status e posição são consultáveis pela
  API, pelo MCP e pelo painel, sem texto, telefone ou nome.
- **Sem WhatsApp utilizável** (sem aba, conteúdo inacessível/desatualizado, sem
  contexto monitorado), a fila fica em `WAITING_WHATSAPP` e volta a `QUEUED` no
  próximo poll READY.
- **Interrupção** (lease expirada, aba recarregada, extensão sem o job) antes de
  `SENDING`: o pedido volta a `QUEUED` na posição original, `attempts` aumenta e a
  fila é pausada (`INTERRUPTED`). A pausa é removida pelo próximo poll READY, sem
  período de espera adicional. Depois de `SENDING`, o resultado é `UNKNOWN` e nunca
  volta à fila.
- **Tempos configuráveis** (painel da extensão e API; sobrescrita por pedido via
  API/MCP; valor fora da faixa é rejeitado): contagem AUTO 5 s (0–30 s); execução
  60 s (20–180 s); espera máxima na fila 30 min (1 min–24 h ou sem limite), contada a
  partir da criação, ao fim da qual o pedido vira `FAILED/REQUEST_EXPIRED`;
  conferência pós-envio 15 s (5–60 s). O MCP não altera as configurações.
- **SUPERVISED** termina em `DRAFTED`. Se já houver um `DRAFTED` anterior para o
  mesmo contato (por conversa ou por número), o novo texto é acrescentado em nova
  linha ao rascunho; caso contrário, o campo da conversa conferida é substituído
  (inclusive um rascunho não relacionado que o usuário tenha deixado ali).
- **AUTO com rascunho pendente** no mesmo contato: se o campo da conversa conferida
  tiver texto, falha com `DRAFT_PENDING_ON_TARGET` sem tocar no rascunho e sem
  clicar; se o campo estiver vazio, segue o fluxo normal e envia.
- O campo de outra conversa nunca é alterado.

## Compatibilidade de versões, aceite e reinício (ADR 0025)

- **Passo obrigatório após atualizar:** rode `scripts/restart-local-services.sh`. Sem reiniciar, a Local API (launchd) segue no build e no schema antigos. `--check` apenas verifica (processo da API iniciado antes de `dist/main.js` ou schema atrás da última migration resulta em saída 1 com "reinício necessário").
- **Protocolo de envio versão 3.** A extensão e o agente macOS informam `protocolVersion` no poll. A API só entrega comando a protocolo 3; versão diferente (ou ausente) recebe `command: null` com `reason: CLIENT_OUTDATED`, sem claim.
- **Contrato inválido na ponta.** Se a resposta da API não satisfizer o contrato do comando (API antiga), o agente macOS não a descarta em silêncio: responde à extensão com `API_OUTDATED` e grava o flow log `NATIVE_HOST / FAILED / API_CONTRACT_MISMATCH`.
- **ACCEPTED e `EXTENSION_NO_ACK`.** Ao receber o comando, a extensão reporta `ACCEPTED`, persistido pela API. `CLAIMED` sem `ACCEPTED` por 20 s (`SEND_ACCEPT_TIMEOUT_MS`) devolve o pedido a `QUEUED` com `EXTENSION_NO_ACK` e pausa a fila. Só vale antes de `SENDING`; não há duplicação.
- **Onde `API_OUTDATED` aparece.** Hoje aparece nos logs da extensão e do agente macOS (flow logs) e como aviso no painel da extensão; não há campo no status do pedido porque a API antiga nunca chegou a gravar a causa. Se a extensão sequer recebe resposta válida, o pedido pode ficar `CLAIMED` até a API ser reiniciada. O pedido nunca avança para `SENDING` nesse caso.

