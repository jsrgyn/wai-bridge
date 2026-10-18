# Fases e paralelismo

| Fase | Conteúdo | Depende de | Paralelo seguro | Gate |
|---|---|---|---|---|
| P0 | Decisões, contratos Zod, ADRs, threat controls | requisitos | Security threat review + Architect, em arquivos disjuntos | Q0 |
| P1 | Harness, simuladores, schema/migrações SQLite | P0 | QA harness e Database schema se contracts freeze não compartilhado | Q1 |
| P2 | Event envelope/outbox, REST local, leitura IA inicial, auditoria | P1 | Event package e API routes apenas após ports aprovados e paths separados | Q2/Q3 |
| P3 | Media cache; envio SUPERVISED | P2 | Media e contrato UI extension fake em caminhos disjuntos | Q2 |
| P4 | AI gateway e MCP tools | P2 + contratos de permissões | AI gateway e MCP package; sem edição compartilhada | Q3 |
| P5 | Mac agent + instalação macOS | P2 + P3; simuladores prontos | scripts de instalação e host IPC em paths separados por tarefa | Q4 parcial |
| P6 | Extension e captura incremental | P5 + simulator | UI harness/extension somente em ownership único por árvore | Q4 |
| P7 | AUTO condicionado e simulado | P3 + P5 + decisão Security/Architect | não paralelizar alteração de API/bridge | Q3/Q4 |
| P8 | Auditoria final, hardening, recuperação, release | P0–P7 | Revisão Security e QA em paralelo, sem coedição de implementação | Q5 |

## Regra de paralelismo

O compartilhamento de contrato não autoriza edição simultânea. O dono do contrato publica versão congelada; mudanças posteriores viram ticket próprio. `packages/shared/**`, lockfile, manifests raiz, `tsconfig*`, configs de lint/teste e `current-state.md` têm um único editor por vez. Revisores recebem artefatos congelados e registram achados fora dos arquivos do implementador.
