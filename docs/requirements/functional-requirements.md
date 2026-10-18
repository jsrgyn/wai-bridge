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
