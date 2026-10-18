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
SUPERVISED espere `WAITING_USER` e clique manualmente em Enviar; em AUTO são cinco
segundos canceláveis. Sem prova, nenhum envio. `UNKNOWN` não permite repetição.

## Pedido direto: número e mensagem

Use `whatsapp_send_to_number` para informar `phoneNumber` internacional com DDI,
`text`, modo e autorização explícita, sem conversationId e sem cadastro prévio do
destinatário no SQLite. A IA gera a idempotencyKey para o pedido. SUPERVISED é o
padrão; para envio automático autorizado, use AUTO.

```json
{"phoneNumber":"+12025550199","text":"Mensagem sintética de exemplo","mode":"AUTO","explicitAuthorization":true,"idempotencyKey":"exemplo-pedido-unico-0001"}
```

O número acima é sintético, não um destinatário para teste real. O pedido é
persistido antes da busca. A API não cria um contato/conversa confirmados apenas
porque um número foi informado. A extensão deve encontrar um único resultado
visível e comprovar o telefone completo no perfil antes de compor e enviar. Se não aparecer nas conversas, pesquisa também o diretório visível de Nova conversa. Nome/telefone conferidos são registrados no SQLite durante WAITING_USER/WAITING_AUTO_SEND, antes de SENDING; isso não cria contato na agenda do celular.
Se não houver resultado acessível, falha sem usar protocolo privado ou outro canal.

Com apenas uma conta local ativa e autorizada, accountId é dispensável. Com várias,
indique accountId; a API não escolhe silenciosamente. Atividade vem de poll nativo
com opt-in nos últimos 15 segundos, persistido em wa_sync_state com escopo próprio.
Monitor ON, permissão de envio e aba ativa com uma conversa identificada continuam
necessários. Ausência de conta ativa retorna ACTIVE_SEND_ACCOUNT_REQUIRED;
ambiguidade retorna AMBIGUOUS_SEND_ACCOUNT. Aguarde o poll após ativar/reconectar.

Repetir a mesma chave e o mesmo pedido normalizado devolve o comando anterior,
mesmo depois que o contexto expira. Outra mensagem/número/conta explícita com a
mesma chave gera conflito. REQUESTED não confirma envio; consultar status até
SENT/FAILED/CANCELLED/UNKNOWN. UNKNOWN nunca autoriza repetição automática.

## Busca e conferência pelo número cadastrado

Em `whatsapp_send_message`, informe `locateByPhone:true` para localizar o contato
individual registrado, mesmo com outra conversa aberta na mesma conta local. A API
exige telefone normalizado no cadastro e copia esse número para o comando; não
aceita inventar número a partir do nome. Localize a conversa por `contactPhone` em
`whatsapp_list_conversations` e use seu UUID. Exemplo de pedido:

```json
{"conversationId":"<UUID cadastrado>","locateByPhone":true,"text":"Mensagem autorizada pelo usuário","mode":"AUTO","explicitAuthorization":true,"idempotencyKey":"<chave única com pelo menos 16 caracteres>"}
```

A extensão preenche o campo de pesquisa, exige um resultado visível, abre a conversa
e o perfil, e compara o telefone internacional completo. Resultado filtrado, nome
ou foto não confirmam identidade. Antes de compor e de enviar, revalida o telefone,
conta local, contexto/raiz e texto. SUPERVISED e AUTO mantêm suas confirmações/espera.

É preciso monitor ON, permissão de envio, aba WhatsApp ativa com uma conversa
identificada na conta correta, busca vazia e ausência de rascunho. Se já houver
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
5. Deixe a aba WhatsApp ativa, o painel de dados aberto e o compositor vazio.

A ferramenta `whatsapp_send_message` recebe:

```json
{"conversationId":"<UUID da conversa vinculada>","text":"Mensagem autorizada pelo usuário","mode":"AUTO","explicitAuthorization":true,"idempotencyKey":"<chave única com pelo menos 16 caracteres>"}
```

SUPERVISED é o padrão: prepara o texto e aguarda o clique manual em Enviar/Enter.
O clique é retido até o SQLite confirmar SENDING. AUTO aguarda cinco segundos
canceláveis na página, revalida contexto/texto e também aguarda confirmação SENDING
antes de clicar. Não solicita nem amplia autorização pelo conteúdo recebido.

O retorno inicial é um ID REQUESTED, não confirmação de envio. Consulte
`whatsapp_get_outbox_status` com esse ID. SENT exige uma bolha de saída nova,
texto exato e status visível Enviado/Entregue/Lido (ou equivalente inglês). Isso
comprova apenas o que foi observado na UI, não uma confirmação de protocolo oficial.
Resultado incerto vira UNKNOWN: não reenviar automaticamente. A captura normal
registra a mensagem de saída e o diálogo continua disponível pelo MCP.

## Cancelamento e limites

Use o botão Cancelar envio WAI Bridge durante a espera, ou
`whatsapp_cancel_extension_send({id})` antes de SENDING. Desmarcar a permissão
interrompe preparação/espera. Depois de SENDING não é possível desfazer o efeito.

Rascunho existente não é sobrescrito. Em falha pré-envio, o texto preparado pode
permanecer para revisão; a extensão não apaga rascunhos automaticamente. Mudança de
conversa, aba oculta, vínculo inválido, opt-in revogado ou estrutura ambígua impedem
o clique. Se a lease de execução expirar após SENDING, fica UNKNOWN sem retry.
SUPERVISED precisa ser concluído dentro da lease de três minutos. REQUESTED expira
após cinco minutos. Comandos legados `send` continuam separados e simulados.

Cada confirmação é válida para a janela/contexto atual. Não reutilize um grupo
local para outro grupo. Nomes, fotos e participantes não autorizam destinatários.
Compatibilidade com o DOM real permanece experimental; testes automatizados usam
somente páginas e dados sintéticos. Não foi realizado envio real por este novo fluxo.

## Aba oculta e perfil aberto

O poll registra a conta autorizada mesmo quando a aba selecionada está oculta, mas
só reivindica pedidos quando ela estiver visível. Após solicitar pelo MCP, volte ao
Chrome/WhatsApp para começar. REQUESTED expira em cinco minutos. Se a visibilidade
mudar entre claim e preparação, o executor aguarda dentro da lease; durante envio,
ocultar bloqueia novas ações (`WHATSAPP_TAB_NOT_VISIBLE`). Outros gates distinguem
`EXTENSION_SENDS_DISABLED` e `SEND_LEASE_EXPIRED`. Com um pedido explícito pendente e opt-in, uma única aba compatível do WhatsApp pode ser ativada automaticamente (ADR0015); nenhum foco muda quando não há pedido.
Checkbox de notificações, controles ocultos e busca no perfil não impedem fechá-lo;
campos de edição de texto visíveis continuam protegidos (`PROFILE_HAS_INPUT`).
Em SUPERVISED, alternar para o MCP após preparar mantém WAITING_USER e o rascunho
dentro da lease. É preciso voltar à aba visível para o clique manual.

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

SEND_EXECUTE confirma aceitação imediatamente; não espera o usuário enviar para
responder ao background. Durante SUPERVISED, o background continua consultando o
estado autenticado da mesma lease. Cancelamento no MCP aborta a espera local no
próximo poll. ACK perdido nunca causa nova execução. Sem resposta da aba, o timeout
libera a rotina de consulta, e um comando já reivindicado aguarda recuperação
persistente sem ser reenviado. Captura lenta no native host não bloqueia progresso.

`whatsapp_status` agora inclui `extension.native`, `bridge`, `ready`, `lastPollAt`,
`protocolVersion`, `build` e contagens da fila. O status geral ok descreve API/DB;
não confirma a ponte pronta. STALE significa poll antigo (>15s); CONTENT_UNREACHABLE
indica aba sem resposta; CONTENT_OUTDATED indica builds diferentes entre script e
background; NO_MONITORED_CONTEXT exige monitor ON e uma conversa aberta. READY com
protocolo 2 e build atual confirma contexto vivo, sem comprovar envio. EXECUTING
com fila WAITING_USER é espera manual. Não há contatos/texto/tokens no diagnóstico.

Perfil do destinatário já aberto com telefone exato é reutilizado antes de buscar;
continua verificando conta, rascunho e identidade. Não há redução dos cinco segundos
de AUTO nem permissão para enviar ocultamente. Consultar status/outbox não envia.
