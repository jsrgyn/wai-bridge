# ADR0021 — Cadastro, revisão e operação resiliente

Data:2026-10-19. Estado: Accepted pelo pedido de implementar todos os pontos sugeridos, sem retirar fluxos existentes.

Ordem: contratos/testes; cadastro local; revisão de referências; painel operacional; fila resistente; relatório/retry de lotes; políticas; backup/retenção; diagnóstico de UI; permissões MCP. SQLite permanece autoridade. Catálogo local sobreposto aos dados observados evita que captura sobrescreva edição e impede que editar telefone altere prova/roteamento de envio existente. Criação/edição exige confirmação literal, idempotência e versão para concorrência. Relações são explícitas.

Candidatos a referências duplicadas são propostas paginadas por conta/tipo/telefone comprovado ou nome normalizado, sem fundir históricos. Confirmar associação reutiliza validação existente; rejeitar candidato é persistente. Não encerrar pendência por mera associação.

Dashboard empacotado na extensão usa operações administrativas allowlisted via Native Messaging→API autenticada, sem tokens no Chrome. Remetente restrito a páginas da própria extensão. Lista/cadastro/referências/políticas/relatórios/pausa-retomada são deliberados; texto de contato/mensagem não vira HTML nem comando.

Fila continua buffer chrome.storage, não novo banco: limites por itens/bytes, ACK persistido, retry idempotente, quarentena de dados inválidos e métricas de overflow/falhas/lacunas. Nunca descartar inválidos silenciosamente, nem remover válidos antes de ACK. Telemetria sem corpos e disponível no painel/API.

Políticas favoritas/prioridade/INCLUDE/EXCLUDE/INDIVIDUAL_ONLY são verificadas antes da vez no lote; leitura individual deliberada preservada. Relatório final paginado resume sucessos/falhas/ignorados/pendências; nova tentativa somente de falhas é outro pedido explícito e idempotente, sem repetir sucessos.

Backup automático no processo API local, intervalo configurável, verificação SQLite integrity/FK e restauração em clone temporário. Caminho fixado pelo servidor fora de entradas externas, arquivos0600. Retenção configurável limita backups gerenciados e diagnósticos; exclusão desabilitada por padrão e exige autorização literal específica. Nunca apagar mensagens, contatos, anexos, auditoria ou snapshots por esta entrega. Preservar mínimo de backups e último verificado.

Diagnóstico reconhece capacidades da UI, sem protocolos privados ou HTML bruto; bloqueia sync em contexto incompatível e mantém guards de envio existentes. Permissões MCP por capacidade são opt-in de restrição (perfil omitido preserva comportamento legado); enviar ainda exige gates/autorização anteriores, mesmo quando capacidade SEND é concedida. Contratos/testes sintéticos, sem conta real/envio real em automação. Migration016 aditiva, não modificar migrations anteriores.
