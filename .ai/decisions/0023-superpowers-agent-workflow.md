# ADR 0023: Fluxo de agentes com o plugin Superpowers

- Data: 2026-10-22
- Status: Proposed

## Contexto

Agentes que trabalham no repositório seguem o `AGENTS.md` e os documentos em `.ai/`, mas não há um fluxo padronizado de brainstorming, planejamento, TDD, revisão e fechamento de branch. O Claude Code lê `CLAUDE.md` e `.claude/settings.json`, que não existiam.

## Decisão

Habilitar o plugin Superpowers no escopo do projeto via `.claude/settings.json` e criar `CLAUDE.md`, que importa o `AGENTS.md` e adapta as skills às convenções locais: planos em `.ai/plans/`, ADRs em `.ai/decisions/`, worktrees em `.worktrees/`, validação por `pnpm lint`, `pnpm typecheck` e `pnpm test`. As regras do `AGENTS.md` prevalecem sobre os padrões do plugin.

## Alternativas consideradas

- Instalação apenas no usuário: não é reproduzível para outros colaboradores.
- Não adotar o plugin: mantém o fluxo atual sem disciplina explícita de TDD e verificação.

## Consequências

Colaboradores que usam Claude Code recebem o pedido para confiar no marketplace e instalar o plugin. Outros agentes de IDE não são afetados. `git push` é negado por padrão nas permissões do projeto. Leitura de `.env` é bloqueada para o agente. A instalação efetiva do plugin depende de cada usuário e não é verificada por este ADR.
