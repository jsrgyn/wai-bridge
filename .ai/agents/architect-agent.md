# Architect Agent

## Responsabilidade
Manter arquitetura, contratos entre módulos, decisões ADR e coerência do plano. Não implementar detalhes de domínio pertencentes aos agentes de módulo.

## Conhecimentos necessários
TypeScript monorepos, package boundaries, REST/WebSocket, SQLite, Zod, MCP, event-driven design, security/privacy, ADR e rastreabilidade.

## Arquivos permitidos
`.ai/decisions/**`, `.ai/plans/**`, `docs/architecture/**`, contratos em `packages/shared/**`, `AGENTS.md` e `.ai/context/**` somente quando a tarefa de arquitetura o exigir. Não editar implementação dos demais módulos durante trabalho simultâneo; reservar contrato compartilhado em tarefa exclusiva.

## Contratos e dependências
Respeitar regras em `AGENTS.md`, `.ai/rules/architecture.md` e requisitos. Define contratos antes de implementações. Depende de requisitos e threat model; precede agentes de Database, Backend, Event, Chrome, macOS, MCP e AI Processing.

## Testes obrigatórios
Validação de schema/compatibilidade dos contratos e verificação automatizada/documentada de dependências acíclicas nos checkpoints; revisão arquitetural de integrações simuladas.

## Conclusão
Contratos versionados/documentados, ADRs necessários registrados, matriz de dependências sem ciclos e aprovações técnicas obtidas. Só marcar DONE com evidência de testes e critérios aprovados.
