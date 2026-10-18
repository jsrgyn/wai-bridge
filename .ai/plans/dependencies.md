# Dependências, interfaces e contratos em aberto

## Grafo direcionado proposto

`shared contracts → database → events → local-api → {mac-agent, MCP}`

`local-api + mac-agent protocol → Chrome extension`

`local-api contracts → media cache`

`local-api + MCP + AI safety contracts → ai-gateway`

`simulators → extension/mac-agent/API end-to-end`

Não são permitidas dependências de packages para apps, API/MCP para acesso direto ao DB fora dos adapters aprovados, nem ciclos entre MCP e AI gateway. Composição: API → domínio/persistência; MCP → API; AI gateway → MCP/API contratados; extension → mac-agent → API.

## Paralelismo sem colisão

- Security Agent pode escrever threat model enquanto Architect define schemas em packages/shared, até revisão conjunta.
- QA pode criar harness em `tests/**` enquanto Database atua em `packages/database/**`, uma vez congelados schemas.
- Event package e API somente em paralelo com interfaces publicadas, diretórios de implementação disjuntos e nenhum arquivo shared em edição.
- Media package e documentação/fixtures UI podem avançar em paralelo; captura real espera P5.
- MCP package e AI gateway podem desenvolver com client/API simulados e contratos congelados; integração ocorre em ticket serial.
- Auditorias e QA independentes podem rodar em paralelo em P8 sem escrever nos módulos sob revisão.

## Contratos ainda indefinidos (bloqueiam implementação consumidora)

1. Identidade e deduplicação de mensagem/evento, relógio, ordenação, origem e semântica para conteúdo parcial/indisponível.
2. Schema SQL, política/versionamento de migrações, chave primária, retenção e estratégia de backup/restore; criptografia e gestão de chaves.
3. Envelope de evento, outbox/entrega pelo menos uma vez, cursor/replay, ack, expiração, backpressure e autorização WebSocket.
4. API REST: recursos/rotas, paginação, erros, versão, autenticação local, origem/CORS, autorização e limites.
5. Protocolo de extensão↔Native Messaging host/mac-agent, framing, limites, handshake, auth, lifecycle, compatibilidade MV3 — definido como v1 em `.ai/decisions/0003-native-messaging-v1.md`; captura e operações de produto seguem fora do contrato.
6. Critério de “novidade” sem histórico, persistência de cursor, comportamento após reload, abas múltiplas e limites de DOM acessível.
7. Política de anexos: tipos/tamanho, cache, nomes seguros, symlink/path traversal, limpeza, dedup e retenção.
8. Máquina de estados IA completa: transições, quem pode claim/confirmar, leases/timeout, retry, FAILED/requeue e idempotência.
9. Envio: validação/normalização de destinatário, capacidade realmente suportada, definição de “resultado verificável”, autorização/consentimento, persistência e estados de cancelamento/AUTO. Requer gate humano/security antes de implementação.
10. MCP: catálogo exato de ferramentas, transport, auth, scope, confirmação de ação, limites e resposta a timeout.
11. Log/auditoria: campos permitidos, retenção, redaction e correlação sem PII excessiva.
12. Limite de processo: se DB é aberto pelo agente macOS ou exclusivamente API; arquitetura atual diz API lógica de negócio e acesso backend, mas “agente intermedeia” não fixa ownership físico do arquivo SQLite. Decidir antes do schema/runtime.

Decidir em ADR no P0; contratos não podem ser inventados durante implementação.
