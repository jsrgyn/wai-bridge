# Estado verificado do projeto

Atualizado em 2026-10-19. A linha principal de implementação usa SQLite schema 16 e migrations aditivas. O workspace tem extensão Chrome, agente macOS, Local API e servidor MCP compiláveis. Contratos entre fronteiras usam Zod; o servidor MCP acessa a Local API em localhost, não abre o banco.

## Capacidades implementadas

- Captura incremental e telemetria limitada ao conteúdo/metadados renderizados na interface; fila local durável com limites, ACK persistido e sinalização de lacunas.
- Reconciliação de até 50 mensagens visíveis por solicitação explícita, fila de revisão/pendências, estágios e confirmação separada da leitura do WhatsApp.
- Consulta paginada do catálogo de contatos local, filtros por nome/apelido/relação e período; cadastro e edição confirmados pelo usuário.
- Lotes seriais baseados em lista congelada e autorizada, relatório, cancelamento, retomada e retry apenas de falhas, com políticas por conversa.
- Painel de operações para status, contatos, propostas de referência, políticas, lotes e manutenção/backup verificado.
- MCP com permissões por capacidade, e opt-ins de escrita/envio separados; logs operacionais sem conteúdo de mensagem por contrato.

## Limites conhecidos

- A extensão observa a UI acessível e não garante captura integral, estabilidade de seletores ou histórico completo. Dados renderizados continuam não confiáveis.
- Atualizações da extensão não substituem necessariamente a recarga de uma aba já aberta; a compatibilidade estrutural precisa ser verificada antes de operações visuais.
- Abrir uma conversa pode alterar os indicadores de leitura próprios do WhatsApp. Pedido de sincronização não confirma leitura pela IA.
- O runtime local não é uma integração de envio de produção: envio real não deve ser habilitado ou testado como se fosse garantido; AUTO é negado pelo verificador padrão.
- O MCP usa transporte stdio; clientes precisam reconectar após rebuild para descobrir ferramentas atualizadas.
- Backup local validado não substitui cópia independente/criptografada nem uma política de recuperação operacional.

## Validações registradas

Na implementação do schema 16 foram observados: `pnpm build`, `pnpm lint`, `pnpm typecheck`, typecheck da extensão e build MCP com exit 0; `pnpm test` (233 testes em 30 arquivos), `pnpm test:integration` (9 testes em 6 arquivos), unitários da extensão (33 testes em 9 arquivos) e Playwright completo (116 testes) passaram. Testes usam fixtures sintéticas e não executam envios reais. Para validar novamente após alterações, execute os comandos atuais listados no README; este registro não substitui uma execução nova.

## Privacidade da documentação

Este arquivo é versionado em um repositório público. Deve conter apenas fatos técnicos genéricos e resultados de testes sintéticos. Não registrar nomes de interlocutores, corpos de mensagens, números, e-mails, IDs de execução, caminhos absolutos de usuário, estado de uma conta real ou contagens obtidas de dados privados.

As regras públicas e o hook local agora bloqueiam arquivos privados conhecidos, artefatos binários de risco, identidade Git pessoal e segredos detectáveis em mudanças staged. Gitleaks não encontrou achados nos arquivos atuais; em repositório temporário, o hook passou com fixture segura e bloqueou caminho privado e uma chave sintética staged. O histórico Git publicado não foi reescrito; commits já existentes mantêm seus metadados e cópias remotas. Racional, alternativas, consequências e evidências desta proteção estão registrados no [ADR 0022](../decisions/0022-public-repository-privacy-hardening.md).

## Ferramentas de agentes

Em 2026-10-22 foram adicionados `.claude/settings.json` (habilita o plugin Superpowers no escopo do projeto e define permissões), `CLAUDE.md` (importa o `AGENTS.md` e adapta as convenções do plugin) e a entrada `.worktrees/` no `.gitignore`, conforme o [ADR 0023](../decisions/0023-superpowers-agent-workflow.md). Não houve alteração de código de aplicação. A instalação do plugin em cada máquina não foi verificada.
