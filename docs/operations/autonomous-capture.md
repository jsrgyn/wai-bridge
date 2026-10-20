# Captura automática da interface visível

Com o monitor ON, a extensão atribui uma referência local à conversa aberta sem
pedir cadastro de contato/grupo, leitura manual de perfil ou confirmação de vínculo.
ON é retomado após recarregar a página; OFF continua OFF. Atualizar a extensão
exige recarregá-la no Chrome e recarregar uma vez o WhatsApp Web.

Entradas e saídas novas renderizadas seguem o mesmo caminho: extensão → native
host → API → SQLite. Saídas sincronizadas do celular são tratadas como OUTBOUND
quando aparecem na interface com direção reconhecida. Não há importação inicial
do histórico nem acesso ao protocolo privado. Referências são registradas mesmo
com a opção de envio pelo MCP desligada. Essa opção continua controlando envios.

`whatsapp_list_conversations` localiza as conversas persistidas;
`whatsapp_get_dialogue` recebe `conversationId`, retorna as mensagens observadas
em sequência, direção, interlocutor e paginação para mensagens anteriores.
`accountWideCoverage=false` e `previousHistoryImported=false` explicitam os limites.
`identitySource=VISIBLE_UI`, `identityStatus=PARTIAL` e
`identityContinuity=CURRENT_UI_REFERENCE` distinguem a referência automática.
`confirmedAt` nessa modalidade indica a observação local, não confirmação humana.

A referência automática usa UUID de objeto visual e um namespace local do navegador.
Não usa nome, foto, índice da lista ou hash do nome como chave global. Nomes iguais
em linhas distintas ficam separados. Recarregar a página, reciclar linhas ou renomear
pode fragmentar a conversa em novas referências; não há união automática por nome.
A classificação contato/grupo fica UNKNOWN quando não há evidência explícita.
As referências manuais anteriores continuam disponíveis nas opções avançadas.

## Limite verificado

O painel fechado não renderiza o diálogo inteiro. A lista lateral pode sinalizar
atividade sem disponibilizar o conteúdo das mensagens. A extensão não navega por
contatos, não rola histórico e não transforma prévias em diálogos completos.
Portanto, esta implementação automatiza a captura da conversa aberta; não garante
todas as mensagens da conta, mensagens durante desconexão ou continuidade entre
sessões. A IA deve informar essa cobertura parcial ao responder.

Para garantir recebimento de todas as mensagens independentemente da conversa
aberta será necessária uma integração suportada de eventos, com identidade estável
e regras próprias de sincronização. Isso não pode ser prometido pelo DOM atual.

## Atividade em conversas fechadas

O observador da lista também acompanha mudanças das prévias e horários das linhas
renderizadas. Isso inclui sinais que podem ser produzidos por envios de outro
cliente sem aumentar a contagem de não lidas. A referência inicial é estabelecida
sem emitir/importar as prévias existentes; parar o monitor encerra a observação.
As comparações são limitadas e ficam apenas na memória, sem virar identidade.

Mudanças geram CONVERSATION_ACTIVITY/DETECTED, com direction=UNKNOWN,
content=null e contentAvailability=UNAVAILABLE. Essa atividade segue o caminho de
persistência existente e não é convertida em diálogo completo. A lista é
virtualizada: linhas não renderizadas e duas mensagens com a mesma prévia/horário
podem não produzir um sinal distinguível. Esse mecanismo não satisfaz FR-13 sozinho.

## Identificação exibida pelo WhatsApp

O cadastro persiste nome do contato e telefone internacional quando observados;
grupo persiste seu nome. O telefone pode ser complementado automaticamente ao
aparecer no perfil visível correspondente à conversa, sem confirmar vínculo manual
nem esperar uma nova mensagem. O perfil precisa estar aberto e visível; a extensão
não o abre sozinha. Até haver evidência inequívoca, telefone fica null. Não é
possível obter um número que o WhatsApp não expõe apenas a partir do nome salvo.

## Atualizações observadas desde ON (2026-10-19)

Além de inserções, o monitor acompanha mudanças semânticas de mensagens presentes no DOM desde ON, inclusive as que já estavam na tela ao ativar: texto/direção, preenchimento tardio e tipos de anexo reconhecidos. Uma referência UUID local com revisão crescente atualiza a mesma mensagem no SQLite. Observações anteriores permanecem imutáveis para auditoria; revisões antigas não sobrescrevem recentes. Não deduplicar mensagens diferentes por conteúdo igual. O baseline inicial é apenas uma comparação em memória, sem publicar o histórico. Se texto ou mídia mudar depois de ON, publica somente o estado alterado; mudanças posteriores atualizam a mesma referência. Rerender sem mudança semântica não importa mensagens. OFF cancela timers e observadores; raízes removidas são desconectadas.

Atividades da lista recebem a referência de objeto visual da própria linha, e não a identidade da conversa que por acaso está aberta. Quando aquela linha for aberta na mesma sessão/contexto, suas mensagens compartilham a referência. Homônimos permanecem separados. Isso registra uma conversa como a Lauanda na lista persistida quando sua linha renderizada mudar, mas não fabrica o conteúdo ausente da prévia. A lista continua virtualizada e a continuidade após reload/reciclagem não é garantida.

Use `whatsapp_list_conversations` com `query` por trecho de título, depois `whatsapp_get_dialogue` com o UUID. O retorno inclui `captureCoverage`: contagens de mensagens/atividades, texto ou mídia indisponível, observações de direção desconhecida e últimos20 sinais de atividade (com indicação de truncamento). Atividade não equivale a mensagem pendente de captura nem prova quantidade exata de mensagens faltantes. `complete=false` é deliberado. Cada mensagem traz até16 metadados de mídia (id/tipo/disponibilidade/estado), total e truncamento; não são bytes ou caminhos.

Mídia visível pode gerar apenas metadados UNAVAILABLE; não há download/transcrição/análise automática por esta entrega. Emoji não deve virar anexo IMAGE. Mensagens enviadas de outro dispositivo são OUTBOUND quando a direção aparece na UI; não se identifica o aparelho de origem por suposição.

A fila durável só remove observações após ACK persistido e agora reenvia o mesmo ID após cinco segundos sem ACK. Isso não repete envios WhatsApp. Limite continua100 itens; fila cheia/indisponível é erro, não garantia de perda zero. Monitor ON não impede perdas por ausência de DOM, desconexão, virtualização ou limites. Não há navegação/rolagem automática nem recuperação retroativa de conversas perdidas.

### Validação manual

Após recarregar extensão e WhatsApp e reconectar MCP, mantenha ON e a conversa aberta. Envie pelo celular uma frase única, peça uma resposta ao contato e depois edite uma mensagem nova ou receba um anexo. Consulte o diálogo: entrada/saída corretas, última revisão sem duplicação e anexo com disponibilidade real. Em outra conversa renderizada na lista, provoque uma novidade: a busca de conversas deve mostrar a referência/atividade; a API deve declarar conteúdo incompleto quando o diálogo não estava acessível. Ao desligar OFF, novas mutações não devem produzir observações.

### Mutações do HTML e mensagens já existentes

MutationObserver acompanha inclusões/remoções de filhos, alterações de nós de texto e atributos nas raízes de mensagens e na lista. A extensão compara conteúdo, direção, remetente e tipos de mídia reconhecidos; não persiste HTML bruto, atributos decorativos, animações ou uma cópia do documento a cada mutação. Mudanças no status visível da prévia também geram atividade quando seus indicadores reconhecidos mudam, inclusive alterações somente em data-icon.

Mensagens que já estavam renderizadas em ON passam a ter um snapshot inicial apenas em memória. Uma edição ou um anexo que aparece depois gera observação no fluxo existente para a API/SQLite, mesmo se a mensagem tiver data antiga. A primeira versão persistida corresponde à alteração observada agora; não reconstrói a versão anterior. Inserções de histórico antigo com data reconhecida continuam excluídas. Wrappers aninhados de mensagem são tratados como a mesma bolha; alterações subsequentes e rerender com marker conhecido preservam a referência na sessão.

Teste adicional: com uma mensagem já renderizada antes de ON, altere-a pelo celular após ativar o monitor e consulte o diálogo. Deve aparecer o estado atualizado, com direção verificável, sem duplicação por mudanças cosméticas. Anexos continuam metadados, sem garantir bytes; eventos sem evidência semântica reconhecível e conteúdo não renderizado continuam fora da cobertura garantida.

## Conferir e sincronizar um diálogo sob demanda (ADR0018)

Peça à IA: **“Use o wai-bridge para sincronizar e conferir a conversa da contato de teste no WhatsApp.”** A ferramenta `whatsapp_sync_dialogue` aceita `query` (nome de contato/grupo ou telefone internacional), `accountId` opcional, `limit` de1 a50 (padrão50) e `idempotencyKey` opcional. Reutilizar a chave recupera o mesmo pedido; um novo pedido precisa de nova chave. `whatsapp_get_sync_status` recebe o UUID do pedido para consultar sem navegar novamente.

O fluxo persiste primeiro o pedido na API. A extensão ON recebe o job por Native Messaging, localiza um único resultado acessível, abre a conversa e reconcilia até50 bolhas já renderizadas. Não rola, não clica em carregar mensagens antigas, não compõe nem envia; abrir pode alterar a leitura do próprio WhatsApp, sem alterar AI `UNREAD/READ`. A captura não depende da permissão de envio pelo MCP. Rascunho, pesquisa já preenchida, ambiguidade, interferência, troca de conta/contexto ou aba incompatível bloqueiam a operação.

A API valida lease/conta/identidade, persiste observações e resultado em transação e devolve o UUID da conversa e IDs das mensagens. O MCP lê o conteúdo exclusivamente do SQLite via API, na ordem do snapshot renderizado (`orderBasis=VISIBLE_UI`); mensagens antigas recuperadas depois não invertem o diálogo por sequência de inserção. Estado `synchronized=true` exige `SUCCEEDED` confirmado no banco. `REQUESTED/CLAIMED/FAILED/EXPIRED` retornam `synchronized=false`, sem apresentar diálogo antigo como recém-conferido. O MCP aguarda até18s; pedidos têm TTL30s e podem ser consultados por ID. `observedCount/persistedCount` contam observações, não downloads de mídia nem garantia de corpos completos. `unknownDirectionCount` explicita direções não projetadas como mensagens; `messageIds` contém as mensagens conhecidas, na ordem da UI. `truncated` indica limite de bolhas, `complete=false` continua obrigatório. Este é um snapshot limitado solicitado pelo usuário, incluindo mensagens anteriores já na tela (`renderedSnapshotImported=true` / `previousHistoryImported=true`), sem varredura histórica global.

Enquanto ON, o monitor automático também tem comparação periódica de2s para recuperar raízes ativadas por atributos/hidratação que escapem do callback incremental. Raiz substituída não vira baseline cego: preserva referências conhecidas na sessão e processa mensagens com data recente verificável; mensagens iniciais sem prova de recência continuam baseline, até mudança observada ou reconciliação solicitada. Citações não substituem o corpo novo da resposta e mídia citada não vira anexo da resposta. Alterar somente a lista lateral pode preservar a referência da conversa se os mesmos markers de mensagens visíveis provarem continuidade; dois homônimos simultaneamente renderizados continuam separados. O intervalo é uma recuperação local, não SLA em abas suspensas/fechadas ou desconectadas.

### Teste de aceite após atualizar

1. Recarregue extensão, depois WhatsApp e reconecte o MCP. Confira build novo e schema13.
2. Mantenha ON e abra uma conversa. Envie uma frase única pelo celular; peça resposta, edite uma mensagem e teste resposta com citação. Consulte o diálogo e confira os corpos novos e as direções.
3. Solicite `whatsapp_sync_dialogue` com `query` do contato. Confirme `SUCCEEDED`, `synchronized=true`, contagens e ordem da tela. A resposta vem da API/SQLite após commit, não diretamente do navegador.
4. Repita a conferência: referências da sessão não devem duplicar mensagens; revisões preservam AI read state. Nome ambíguo ou rascunho deve bloquear navegação e não enviar nada.
5. Desligue OFF: novas alterações não devem ser capturadas nem comandos de conferência executados. Conversas não renderizadas continuam sem garantia de conteúdo completo.

## Fila de pendências e conferência deliberada (ADR0019/schema14)

Peça: **“Liste todas as conversas pendentes de leitura.”** `whatsapp_list_pending_conversations` retorna `total`, `items` e `nextCursor`; seguir todas as páginas para listar tudo. `pendingOnly` aceita strings `true` (padrão) ou `false`; filtros opcionais `accountId`, `query`, `stage`, `limit1..100` e cursor UUID. A listagem consulta apenas o banco: não abre nenhuma conversa nem altera indicador WhatsApp/AI READ. Pessoas com nomes iguais permanecem em linhas distintas, identificadas pelo UUID e conta. Não se pressupõe que prévia ou sinal corresponda a uma mensagem.

Peça: **“Abra e sincronize a conversa de [contato da lista].”** A IA deve passar `conversationId` da pendência e título exato ou telefone a `whatsapp_sync_dialogue`; nome ambíguo exige especificar a referência. Um título exato/telefone único já na fila também pode vincular o pedido, depois da verificação de idempotência. A execução continua limitada a50 mensagens renderizadas da conversa solicitada, com monitor ON, sem rolagem, sem envio, sem apagar rascunho, sem execução simultânea com envio e respeitando interferência. Não há varredura nem navegação automática das pendências. Abrir pode marcar a conversa lida no WhatsApp.

Estágios da fila:

| Estágio        | Significado                                               |
| -------------- | --------------------------------------------------------- |
| WAITING_SYNC   | Sinal observado ainda não coberto pela última conferência |
| SYNC_REQUESTED | Pedido deliberado registrado, ainda não reivindicado      |
| SYNCING        | Extensão reivindicou o pedido                             |
| SYNC_FAILED    | Conferência falhou; consultar lastError                   |
| SYNC_EXPIRED   | Prazo do pedido expirou, sem reexecução automática        |
| SYNCED_PARTIAL | Snapshot salvo; aguarda confirmação explícita de leitura  |
| READ_CONFIRMED | Usuário confirmou a revisão conferida; novo sinal reabre  |

Peça: **“Confirme que li essa conversa.”** `whatsapp_confirm_conversation_read` exige `conversationId`, último `syncRequestId` bem-sucedido, `revision` atual e `explicitConfirmation:true`. Não confirme automaticamente ao listar, sincronizar ou responder. O ACK encerra somente a pendência observada até essa revisão; não confirma AI READ por mensagem nem afirma leitura do histórico completo. Sinais após o claim não são apagados pelo snapshot; ACK antigo falha. `unreadCountObserved`/`unreadObservedAt` são a última indicação acessível, podem estar desatualizados ou desconhecidos e não são o contador da fila.

`whatsapp_get_conversation_review(id)` consulta estágio atual sem navegar. `whatsapp_link_conversation_references` associa dois UUIDs somente por instrução explícita, mesma conta e sem conflito de telefone/tipo. Expõe `relatedConversationIds` sem mover/apagar mensagens nem confirmar todas as referências de uma vez. Telefone igual comprovado na mesma conta também permite relação; nome igual nunca basta. Sem prova/associação, uma nova referência após reload não encerra a pendência antiga e uma conferência vinculada incompatível falha.

Migration014 preserva dados/migrations anteriores e semeia pendências conservadoras a partir de sinais persistidos; mensagens incluídas em snapshots anteriores não são tratadas como novas notificações na reconstrução. Não equivale a reconstruir o estado real de não lidas da conta. A fila sobrevive a reinício de API; jobs vencidos ficam expirados até novo pedido deliberado. A fila de transporte da extensão continua limitada: isto não elimina perdas por overflow/desconexão, histórico não renderizado ou conta fora do navegador. Antes de ativar, fazer backup, reiniciar API para schema14, recarregar extensão+WhatsApp e reconectar MCP (26 ferramentas).

Snapshots solicitados são publicados somente pela conclusão transacional do job, sem duplicá-los como notificações de captura ao vivo. A proteção de interferência e rascunho permanece durante a espera de hidratação, até retornar o snapshot. A fila inicial pode conter referências históricas separadas: seu total não é uma contagem de pessoas distintas nem o total atual de não lidas do WhatsApp.
