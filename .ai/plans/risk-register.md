# Registro de riscos

Probabilidade/impacto são avaliações iniciais (Baixa/Média/Alta), não medições. Riscos sem controle comprovado permanecem abertos.

| ID | Risco | P/I | Mitigação/controle planejado | Estado/owner |
|---|---|---|---|---|
| R-01 | Alterações de WhatsApp Web quebram DOM acessível e captura | Alta/Alta | fixtures de contrato, captura incremental conservadora, falhar com estado indisponível; sem scraping de protocolo | Aberto; Chrome + QA |
| R-02 | Novidade confundida com histórico após reload/aba | Média/Alta | decisão explícita de cursor e simulator com reload/multi-tab; sem backfill | Aberto; Architect + Chrome |
| R-03 | Prompt injection em mensagens induz ferramenta/envio | Alta/Alta | separação dado/instrução, allowlist, confirmação e adversarial tests | Aberto até P4; Security + AI |
| R-04 | Acesso local não autorizado via API/port rebinding/origin | Média/Alta | localhost não é auth; auth/origin/CSRF/rebinding threat review e testes | Aberto; Security + Backend |
| R-05 | Envio incorreto/duplicado após timeout ambíguo | Média/Crítica | pre-persist, idempotency, unknown terminal state, sem retry, AUTO go/no-go | Aberto; Backend + Security |
| R-06 | Destinatário ambíguo ou spoofed | Média/Crítica | resolução explícita, confirmação, canonicalização decidida e validação | Aberto; Architect + Backend |
| R-07 | Corrupção/perda SQLite, WAL ou interrupção no meio da operação | Baixa/Alta | transações, migrações, backup/restore e crash injection tests | Aberto; Database |
| R-08 | PII em logs, backups, mídia ou testes | Média/Alta | minimização, redaction, retenção, permissões, synthetic fixtures, scans | Aberto; Security + Database |
| R-09 | Mac Native Messaging malformado/host spoof/privilege escalation | Média/Alta | framing limits, handshake, origin/install validation, simulator adversarial | Aberto; macOS + Security |
| R-10 | Cache mídia path traversal, symlink, arquivo excessivo/malicioso | Média/Alta | nomes opacos, canonical path, quotas/type policy, temp FS tests | Aberto; Backend + Security |
| R-11 | MCP/API autorizam mais ferramentas do que consentido | Média/Alta | catálogo fechado, scopes por operação, revisão independente e audit | Aberto; MCP + Security |
| R-12 | Dependências incompatíveis/instalação nativa better-sqlite3 em Node/macOS | Média/Média | pin/runtime matrix, CI ARM64, builds reproduzíveis, revisão supply chain | Aberto; Architect + Database |
| R-13 | Requisitos de captura/envio incompatíveis com suporte tecnicamente acessível | Média/Alta | capability discovery via simulador/manual, conservador; gates de decisão antes de integrar | Aberto; Architect |
| R-14 | Escopo crescente por contratos de retenção/crypto/auditoria indefinidos | Alta/Média | P0 ADRs, backlog priorizado, não inventar políticas | Aberto; Architect |
| R-15 | Perda de trabalho ou colisões por coedição multiagente | Média/Alta | paths exclusivos, status/handoff, revisor distinto, checkpoints e recovery procedure | Mitigação planejada; Engineering Manager |

## Riscos ainda sem mitigação suficiente

R-03, R-04, R-05, R-06 e R-09 são bloqueadores para ativar IA com ferramentas, API exposta a outros processos ou qualquer envio. R-01/R-02 não elimináveis: o sistema deve degradar para conteúdo indisponível e nunca tentar compensar com histórico/protocolo interno. Criptografia em repouso e gestão de chaves ainda exigem decisão baseada em threat model.
