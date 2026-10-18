# Requisitos e rastreabilidade

Classificação deste snapshot:

- **IMPLEMENTED** — há implementação identificável no código, mas a validação automatizada listada não comprova esse requisito de ponta a ponta.
- **TESTED** — comportamento implementado e exercitado nos testes indicados; não implica integração real/produção.
- **PARTIAL** — parte do requisito foi implementada; integração, cobertura ou limite declarado falta.
- **BLOCKED** — depende de decisão, autorização ou integração externa não disponível nesta fase.
- **NOT_IMPLEMENTED** — não há implementação relevante identificada.

## Requisitos funcionais

| ID | Estado | Evidência / lacuna |
| --- | --- | --- |
| FR-01 observar apenas mensagens novas acessíveis | PARTIAL | Observer ativado manualmente e fixture em `apps/chrome-extension/test/e2e/observer.spec.ts`; sem validação do DOM real e sem alegação de completude. |
| FR-02 identificar contato/grupo quando possível | PARTIAL | Detector usa rótulos/pistas visíveis; identidade estável/verificada não é garantida pela UI. |
| FR-03 registrar inbound/outbound observável | PARTIAL | Estados `CAPTURED/PENDING/FAILED` sintéticos; captura real abrangente não validada. |
| FR-04 persistir eventos/comandos antes de efeitos | TESTED | SQLite event/outbox repositórios e testes de transação/idempotência; executor de extensão isolado. |
| FR-05 armazenar mídia local e metadados | PARTIAL | Serviço de filesystem/cache e testes; API não integra ingestão/download com pipeline de captura. |
| FR-06 API local mediada pelo agente macOS | PARTIAL | API loopback e Native Host grava observações; demais comandos da extensão não são transportados pelo agente. |
| FR-07 notificar por WebSocket | PARTIAL | Worker/notifier abstraídos e testados; servidor WebSocket não está composto na aplicação executável. |
| FR-08 ferramentas MCP documentadas sem bypass | TESTED | MCP stdio/14 tools testados; escrita com opt-in local e API bearer full-access. |
| FR-09 estado de leitura IA por consumidor e ACK | TESTED | Migration 005, rotas/repositório e testes de lease/ACK/recovery. |
| FR-10 envio SUPERVISED/AUTO com gates | PARTIAL | State machine/outbox e executor de fixture testados; não existe adapter WhatsApp real nem transporte end-to-end; runtime nega AUTO. |
| FR-11 registrar somente resultado verificável; UNKNOWN terminal | TESTED | Outbox testa resultado/evidência, timeout, restart e sem retry; evidência de produção não existe porque não há adapter real. |
| FR-12 validar fronteiras e auditar sensíveis | PARTIAL | Zod em REST/MCP/Native host e audit SQLite; cobertura adversarial de segurança incompleta. |

## Requisitos não funcionais

| ID | Estado | Evidência / lacuna |
| --- | --- | --- |
| NFR-01 local-first, banco local, API loopback | TESTED | `apps/local-api/src/main.ts`, migrations/testes; MCP chama API local. |
| NFR-02 TypeScript strict, módulos coesos | TESTED | `pnpm typecheck`, `pnpm lint`, builds passaram; arquitetura ainda tem adapters isolados. |
| NFR-03 Zod, erros explícitos, logs minimizados | PARTIAL | Schemas/erros/redaction presentes; logs LaunchAgent sem rotação e revisão de privacidade não formal. |
| NFR-04 testes sintéticos e sem envios reais | TESTED | Testes executados usam SQLite temporário, mocks e fixture. |
| NFR-05 menor privilégio | PARTIAL | Arquivos privados, API loopback, tools MCP gated; principal API é full-access e token compartilhado. |
| NFR-06 segredos fora de código/arquivos protegidos | PARTIAL | Config local 0600, dirs 0700; token plaintext local, sem keychain/criptografia e sem análise de entropia do segredo. |
| NFR-07 retenção configurável e avaliar criptografia | PARTIAL | Retenção de mídia implementada/testada; retenção de mensagens/backups e criptografia em repouso pendentes. |
| NFR-08 não declarar captura integral | TESTED | Docs/observer identificam experimental/incompleto; sem integração real. |
| NFR-09 cancelamento e não repetir UNKNOWN | TESTED | Outbox tests e extensão sintética; extensão não conectada ao outbox API. |
| NFR-10 macOS Apple Silicon, Node LTS, pnpm, MV3 | PARTIAL | Scripts macOS e build/test local; release assinado/notarizado, pacote instalável e validação em Apple Silicon/versões suportadas pendentes. |
