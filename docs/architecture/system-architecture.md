# Arquitetura do sistema

## Escopo

Contrato-alvo, ainda não implementado. É subordinado a `AGENTS.md`, regras e plano mestre. Nenhuma seção concede permissão para contornar limites de captura, ler credenciais, acessar protocolos internos ou enviar mensagens em testes.

## Componentes e autoridade

- **Chrome Extension MV3**: observa apenas mudanças acessíveis na interface normal; produz observações com proveniência/incerteza. Não abre arquivos locais nem SQLite.
- **macOS Agent**: Native Messaging host/bridge autenticado; encaminha envelopes entre extensão e API. Não contém regra de negócio nem conexão ao banco.
- **Local API (Fastify)**: única autoridade de negócio e processo que abre o SQLite; valida fronteiras Zod, autorização, idempotência, estados e auditoria. Vincula-se a loopback.
- **SQLite/better-sqlite3**: persistência exclusiva de mensagens, eventos, comandos, estado e auditoria. Transações/outbox tornam a intenção durável antes de efeitos/notificações.
- **Filesystem local**: bytes de mídia em diretório privado; SQLite guarda metadados e identificador de armazenamento, não caminhos fornecidos pelo cliente.
- **WebSocket**: entrega notificações derivadas de eventos persistidos, com autorização; consumidor recupera lacunas por cursor/API.
- **MCP Server**: adapta ferramentas allowlisted para API local; não acessa DB diretamente.
- **AI Gateway**: consome dados não confiáveis e opera via capacidades MCP/API autorizadas; não transforma mensagem em instrução administrativa.

## Dependências

`shared contracts → database → events → local-api → {mac-agent, MCP}`; `local-api + mac-agent protocol → extension`; `local-api → media`; `MCP/API → AI gateway` por contratos unidirecionais. Proibido package→app, MCP→DB direto, extension→SQLite e ciclo MCP↔AI gateway. APIs e adapters só podem ser adicionados após contrato versionado.

## Segurança e limites

Bind localhost não autentica por si só: API exige autenticação local, autorização por operação e validação de origem conforme threat review antes de ficar acessível. O Agent valida identidade do host/extension dentro das capacidades suportadas pelo protocolo. Conteúdo externo é dado. Segredos, mídia e DB são locais e excluídos do Git.

## Decisões deste documento

1. **Ownership SQLite**: API local é o único processo com handle de escrita/leitura operacional; macOS Agent somente transporta. Isso resolve provisoriamente a ambiguidade WB-001 sem adicionar banco compartilhado. Mudança exige ADR e revisão do backlog.
2. **Entrega**: eventos têm semântica at-least-once; consumidor deduplica por `eventId`, usa cursor e pode consultar estado. WebSocket não é fonte de verdade.
3. **Identificadores**: UUID interno estável criado localmente; IDs externos são opcionais, escopados por conector e nunca substituem ID interno.
4. **Tempo**: timestamps persistidos RFC 3339 UTC com precisão de milissegundos; ordenação autoritativa usa sequência/cursor local, não relógio de dispositivo externo.
5. **Captura**: o sinal “novo” significa observado em uma sessão ativa após início do monitor, não prova de novidade global/visual. Inicialização não examina histórico visível para backfill.

Essas decisões técnicas precisam de ADR formal em P0 antes da implementação; não são prova de suporte por parte do WhatsApp.
