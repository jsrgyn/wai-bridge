# WAI Bridge — auditoria final de integração, segurança e release

**Data da auditoria:** 2026-10-17 (ambiente local)  
**Escopo:** revisão dos fontes e contratos no workspace, validações automatizadas listadas em `test-results.md`, inspeção de scripts macOS e smoke test de backup/restauração. Nenhum serviço LaunchAgent foi carregado; nenhuma conta WhatsApp real foi conectada; nenhum envio real foi feito.

## Conclusão executiva

O workspace compila e as suítes sintéticas atuais passam. Persistência, migrations, estados de IA, entrega recuperável de eventos, cache local de mídia, MCP stdio, API e motor de outbox possuem componentes implementados e testes de pacote. Os scripts macOS agora preparam instalação, backup, restauração, diagnóstico e atualização sem ativar serviço por padrão.

**O projeto não está pronto para uso operacional com WhatsApp real nem para release de produção.** A coleta não foi validada contra a interface real; o protocolo Native Messaging não entrega comandos de outbox; o executor da extensão está isolado em adaptadores da fixture; não há servidor WebSocket/API de notificação executável; cache de mídia não tem rota integrada de ingestão/download; API usa um principal bearer de acesso total. O envio permanece simulado e AUTO é negado pelo runtime da Local API.

## Arquitetura e contratos

- A Local API é dona da conexão SQLite; repositórios ficam em `packages/database`; MCP chama somente API REST. Fonte: `.ai/rules/architecture.md`, packages e rotas `apps/local-api/src/app.ts`.
- Fronteiras REST, MCP, Native Messaging, mensagens, mídia e outbox usam schemas Zod. TypeScript strict e lint foram executados.
- Captura → API → evento/SQLite foi exercitada em `tests/integration/capture-flow.test.ts`; isso não valida captura completa nem integração WhatsApp real.
- O pacote de eventos persiste e tenta notificar; existe `WebSocketNotifier` injetável, mas não um servidor WebSocket integrado à API.
- `packages/outbox-engine` executa somente com simulador no runtime; `apps/chrome-extension/src/commands/outbox-executor.ts` não recebe comandos do Mac Agent e usa a fixture.
- `packages/media` implementa armazenamento privado por bytes injetados; a API não oferece upload/download de mídia.
- O MCP usa SDK v2 e API local. Escritas ficam desabilitadas por padrão no MCP, mas a API não tem scopes por ferramenta.

## SQLite

- Seis migrations sequenciais com checksum; mudança/ausência de migration aplicada causa erro. Migrations são transacionais.
- `foreign_keys=ON`, WAL, busy timeout, arquivos privados; schema inclui FTS5, índices e triggers.
- Testes cobrem migration idempotente, foreign keys, rollback, concorrência/reabertura, backup consistente, busca FTS5 e leases.
- `integrity_check` foi executado no smoke test temporário de backup/restauração. Índices e integridade também foram inspecionados por migrations e testes.
- Backup consistente usa a API de backup do SQLite. Restauração valida integridade, cria backup pre-restore e troca arquivo atomicamente com o serviço parado.
- WAL e banco precisam estar no mesmo volume local; backup de SQLite não inclui blobs de mídia. A política de backup conjunta para mídia ainda é operacional/manual.

## Eventos e IA

- Cobertura automatizada: inserção/deduplicação, entrega normal, cliente desconectado, timeout/retry, DLQ, lease expirado, recuperação após reinício e sequência persistida.
- API + SQLite + evento foram exercitados em integração sintética.
- AI gateway cobre notificação normal/duplicada, recuperação de eventos perdidos, claims por consumidor, ACK explícito, falha antes do ACK, timeout, retry e adapters multimodais simulados.
- A entrega de notificação não prova execução da IA; consumidor precisa recuperar estado persistido. Nenhum provedor cloud/local real foi configurado.

## Envio

- Cobertura automatizada do outbox: default SUPERVISED, AUTO com autorização injetada, atraso/cancelamento, verificação de destinatário, idempotência, falha/timeout/UNKNOWN, recuperação e serialização.
- Cobertura de extensão é de página sintética: conversa individual/grupo, modo supervisionado, contagem, cancelamento, alteração de conversa, interface alterada, desconexão pré-claim, comando duplicado e UNKNOWN.
- O executor simulado não prova envio externo. API runtime usa `DenyAutoAuthorizationVerifier` e `SimulatedSendExecutor`. O adaptador real não existe.
- `SENT` manual exige evidência de referência; `UNKNOWN` é terminal e não é repetido automaticamente.

## Mídia

- Testes sintéticos cobrem áudio, imagem, vídeo, PDF/texto, cache, hash, corrupção, retenção, disco/root indisponível, traversal e symlink.
- FFmpeg é chamado sem shell e com timeout; análises de vídeo de teste usam transcoder injetado. Presença/robustez do ffmpeg/ffprobe no host não foi validada nesta auditoria.
- Mídia não é baixada do WhatsApp nem exposta por API; provedores cloud exigem HTTPS e opt-in explícito para bytes externos.

## Segurança e riscos

- Segredos não estão em fonte; configuração do agente é JSON local com modo 0600, pastas 0700; API escuta em `127.0.0.1`; comparação Bearer usa `timingSafeEqual`; logs Fastify redigem body, URL, authorization e cookie.
- Native host valida origem allowlist do Chrome e payloads versionados. Extensão não acessa SQLite. MCP não tem SQL nem acesso arbitrário a arquivos.
- Conteúdo de mensagem é dado não confiável nos contratos/providers; testes cobrem flags de política/allowlist de mídia, mas não existe suite adversarial formal de prompt injection ponta a ponta.
- `pnpm audit` não reportou vulnerabilidades conhecidas no snapshot consultado. Isso não é garantia de ausência de vulnerabilidades futuras nem revisão de código das dependências.
- **Risco alto:** a API usa um único token de acesso total e não autentica identidade/escopo por cliente; processo local com token pode fazer todas as operações, inclusive mutations habilitadas.
- **Risco alto:** a integração com UI real é experimental, não tem contrato estável e não foi validada. Não usar para automação de produção.
- **Risco alto:** tarefas de captura/envio/mídia ainda não estão fechadas de ponta a ponta entre UI, agente, API, armazenamento e resultado.
- **Risco moderado:** dados e backups locais não têm criptografia em repouso implementada; proteção atual depende das permissões do usuário/volume.
- **Risco moderado:** logs de LaunchAgent são append-only sem rotação configurada; retenção e capacidade precisam ser operadas pelo usuário.

## macOS e release

- Scripts operam como usuário atual, sem `sudo`. `install-macos.sh` apenas prepara por padrão; `--load` é a ativação explícita do LaunchAgent. Nenhum serviço foi ativado nesta auditoria.
- Diretórios seguem `~/Library/Application Support/WaiBridge/` e `~/Library/Logs/WaiBridge/`.
- `bash -n` passou nos scripts. Smoke test temporário executou os scripts Node de backup/restauração e preservou linha sintética com `integrity_check=ok`.
- Instalador aponta para o checkout atual e Node/pnpm local; não há pacote assinado/notarizado, workflow de release, auto-updater, rotação de logs ou instalação da extensão Chrome automatizada.

## Critério de prontidão

| Uso | Prontidão |
| --- | --- |
| Desenvolvimento/teste sintético | Adequado, com ressalvas listadas |
| Preparação local sem serviço ativo | Adequado após revisar variáveis e arquivos gerados |
| Serviço local persistente | Não recomendado até usuário configurar token/ID, revisar plist e ativar explicitamente |
| Captura em WhatsApp real | Não validada; não declarar operacional |
| Envio em WhatsApp real | Não implementado e proibido nesta fase |
| Release de produção | Não pronto |
