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
