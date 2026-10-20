# Requisitos funcionais

Estes requisitos descrevem comportamento desejado e não afirmam implementação existente.

- FR-01: observar e capturar apenas mensagens novas acessíveis durante uso normal; sem varredura histórica ou coleta indiscriminada de mensagens antigas.
- FR-02: identificar contatos/grupos quando possível e sinalizar identidade ou conteúdo indisponível sem inventar informação.
- FR-03: registrar mensagens recebidas e enviadas quando observáveis, sem declarar captura completa.
- FR-04: persistir eventos e comandos localmente antes de efeitos externos; manter estado no SQLite exclusivo.
- FR-05: armazenar mídias no filesystem local e metadados/referências no banco.
- FR-06: oferecer API REST local para lógica de negócio, mediada pelo agente macOS para a extensão.
- FR-07: notificar consumidores autorizados de mudanças por WebSocket; persistência é a fonte do estado.
- FR-08: oferecer ferramentas MCP documentadas para IA dentro de permissões explícitas, sem bypass da API.
- FR-09: acompanhar leitura pela IA nos estados `UNREAD`, `CLAIMED`, `READ`, `FAILED`, independentemente da leitura no WhatsApp; apenas confirmação explícita marca `READ`.
- FR-10: suportar modos de envio `SUPERVISED` (padrão) e `AUTO`. O modo supervisionado prepara destinatário/texto para envio manual; AUTO exige comando explícito, valida destinatário, prepara mensagem, espera cinco segundos, permite cancelamento e tenta envio apenas quando autorizado e suportado.
- FR-11: registrar resultado de envio apenas quando verificável; não repetir operação cujo resultado seja desconhecido.
- FR-12: validar contratos nas fronteiras usando Zod e auditar operações sensíveis.

## Cobertura autônoma solicitada em 2026-10-18

- FR-13 (solicitado; implementação parcial): enquanto ON e conectado, acompanhar
  mensagens novas de todos os contatos e grupos, incluindo entrada e saída,
  independentemente de envio pelo Chrome, celular ou outro cliente sincronizado,
  sem exigir vínculo manual nem abertura manual de cada conversa. Persistir o
  diálogo no SQLite e disponibilizá-lo pelo MCP por conversa e sequência.
- Aceite de FR-13: uma conversa fechada deve receber novas mensagens nas duas
  direções e o diálogo deve ser recuperável integralmente pelo MCP. Uma atividade
  sem conteúdo ou apenas uma prévia não satisfaz esse aceite. Recarregar não deve
  juntar contatos por nome ou apresentar lacunas como captura completa.
- Estado verificado: a extensão atual captura mensagens acessíveis da conversa
  aberta e detecta mudanças de prévia/horário/não lidas das linhas renderizadas.
  Não captura diálogos completos de todas as conversas fechadas; FR-13 segue aberto.
  Completar exige uma fonte de eventos/identificadores estáveis com cobertura
  verificada para a conta e os grupos do usuário. Não foi selecionado ou conectado
  outro provedor, nem há autorização para contornar protocolos/credenciais.

- FR-14: aceitar pedido autorizado de envio com número internacional e texto, sem
  exigir UUID prévio do destinatário. Persistir intenção, localizar pela pesquisa
  visível, abrir conversa e conferir telefone no perfil antes de compor/enviar.
  Exigir conta local ativa inequívoca (ou explícita), modo/opt-in e idempotência.
  Resultado ausente, ambíguo ou divergente deve falhar sem envio. Não é envio em
  massa nem acesso a protocolo privado; não altera a cobertura parcial de FR-13.

- FR-15: resolver destinatário por nome cadastrado na conta local ativa, aceitando
  correspondência normalizada exata ou trecho com telefone único; rejeitar nomes
  ausentes/ambíguos e telefone ausente sem inferir relacionamento ou número.
  Para número novo, pesquisar a interface (conversas/diretório Nova conversa),
  conferir perfil e registrar nome/telefone no SQLite antes de autorizar envio.
  Replays não refazem resolução nem geram nova operação. Manter SUPERVISED/AUTO.


- FR-16: entrega de comandos deve descobrir abas existentes do WhatsApp e responder
  aceitação sem aguardar término da operação. Um pedido autorizado com opt-in pode
  ativar uma única aba compatível, mantendo execução visível e todas as verificações.
  Durante espera, acompanhar cancelamento pelo MCP e não repetir após ACK incerto.
  Expor diagnóstico de ponte/versão/fila sem conteúdo pessoal; falha de uma aba ou
  captura lenta não deve travar a supervisão indefinidamente.

## FR-17 — trilha operacional correlacionada

Registrar etapas de captura/consulta/envio entre MCP, API, native host, extensão, interface acessível e SQLite com traceId e recurso. Permitir consulta autenticada por trace/comando/observação e filtros de camada/nível, sem conteúdo privado. Diagnóstico best effort, limitado e separado da auditoria e do controle de envio; falha de log nunca implica repetição. Escopo/limites em ADR0016 e docs/operations/flow-logging.md.

### Evolução de FR-13 — 2026-10-19

Capturar mudanças semânticas de mensagens observadas desde ON e anexos tardios por revisões idempotentes; vincular atividades de linhas à própria referência visual; expor busca por título, metadados de mídia e cobertura/lacunas no diálogo. Watchdog de ACK evita espera indefinida na fila de captura. FR-13 integral permanece parcial: não há prova de todos os diálogos fechados/não renderizados, importação histórica ou cobertura desconectada. ADR0017 define a entrega e seus limites.

### FR-18 — Conferência explícita de diálogo renderizado (2026-10-19)

Ao pedir à IA para verificar uma conversa atual de contato/grupo/telefone, oferecer `whatsapp_sync_dialogue`: persistir intenção, localizar resultado único pela UI, abrir a conversa e reconciliar até50 mensagens já renderizadas com o SQLite pela API. Somente após commit devolver diálogo persistido na ordem visível; pendência/falha não pode retornar cache antigo como sincronizado. Exigir monitor ON, conta/identidade/lease, exclusão com envio, idempotência e TTL. Não rolar histórico, navegar homônimos ambiguamente, apagar rascunho, enviar mensagem ou marcar AI READ. Reconsulta por ID com whatsapp_get_sync_status. Snapshot anterior visível é autorizado neste comando específico; cobertura completa da conta e FR-13 integral continuam abertos. ADR0018 detalha contrato e limites.

### FR-19 — Pendências e estágios por conversa (2026-10-19)

Persistir sinais de atividade e mensagens recebidas por referência de conversa, deduplicados por observação, e metadados das não lidas renderizadas em ON sem importar prévias/histórico. Listagem paginada deve informar total, próxima página, estágio, revisão, último sinal, indicador observado, resultado de conferência e cobertura parcial. Listar nunca navega. Conferir somente por solicitação do usuário à IA, reutilizando FR-18, até50 mensagens renderizadas. conversationId opcional vincula pedido à referência selecionada; referência incompatível bloqueia commit. Resultado único por título exato/telefone na fila pode vincular automaticamente o pedido deliberado, sem unir identidades.

Conferência parcial não confirma leitura. ACK explícito exige último job SUCCEEDED e revisão atual verificada; repetição idempotente, sinal posterior reabre, sinal durante conferência permanece pendente. Redução do indicador WhatsApp atualiza metadados, sem confirmar leitura nem reabrir por si só. Falhas/expiração/reinício preservam pendências; não refazer navegação automaticamente. Relações de referências exigem telefone comprovado na mesma conta ou associação explícita de UUIDs compatíveis, sem fundir históricos nem autorizar envio. ADR0019.

### FR-20 — Diretório de contatos exclusivamente local

GET /api/contacts/directory e whatsapp_list_contacts devem retornar apenas linhas registradas em wa_contacts, incluindo display_name/name, nickname, full_name/fullName, phone_number/phone e data de cadastro. Campos ausentes null, sem inferência por nome/parentesco e sem navegação ou coleta adicional. Preservar rotas legadas /api/contacts e /api/contacts/search. Filtros query+match EXACT/STARTS_WITH/CONTAINS com caixa/acentos normalizados e comparação literal, combináveis com registeredPeriod TODAY/YESTERDAY, registeredOn ou registeredFrom/To inclusivos. Fuso IANA padrão America/Sao_Paulo, limites UTC semiabertos e DST corretos. Total/paginação por UUID sem união silenciosa de linhas.

### FR-21 — Leitura sequencial de pendências explicitamente solicitada

whatsapp_sync_pending_conversations cria lote persistente ALL_PENDING (snapshot atual) ou SELECTED (array em ordem). Exigir explicitAuthorization:true/idempotencyKey; uma conta inequívoca, máximo5000 sem truncamento e um lote RUNNING de cada vez. Array de UUIDs+posição/total/runToken atravessa Native Messaging e chega à extensão. Executar um job por vez, criando-o somente na sua vez, até50 renderizadas conforme FR-18. Não expandir com novas pendências, não rolar/enviar/confirmar AI READ ou leitura da fila. Status, contagens, erros, próximos itens e diálogos persistidos devem ser paginados por MCP/API.

Cancelamento autenticado deve alcançar o job ativo pela mesma lease e impedir itens seguintes; preservar commits anteriores. Interferência/rascunho entre itens também bloqueiam navegação. Pausar falhas operacionais/incertas; retomar somente explicitamente com novo runToken, sem repetir sucessos, e retryFailedItem=true para nova tentativa do item falho. Expiração global24h, falha por item sem sucesso presumido, replay idempotente e recuperação sem reexecutar navegação incerta. Casos sem identidade/contato válido permanecem pendentes e são reportados; múltiplas contas exigem seleção. ADR0020.

## Evolução operacional aditiva — ADR0021

Cadastro local confirmado/versionado/idempotente com relações explícitas; revisão paginada de referências sem fusão; dashboard local sem token; fila persistente limitada por itens/bytes e métricas de lacunas/quarentena; relatório de lotes e novo pedido explícito só das falhas; políticas de favorita/prioridade/exclusão/somente individual verificadas antes de cada vez; backup automático consistente com restauração de clone verificada e retenção de backups/logs adicional somente autorizada; diagnóstico estrutural da UI com falha segura; capacidades separadas no processo MCP preservando perfis legados e gates de envio. Regras, limites e ativação no [guia operacional](../operations/operational-console.md). Rotas e contratos no [contrato REST](../api/local-api.md).
