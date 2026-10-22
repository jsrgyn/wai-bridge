@AGENTS.md

## Superpowers neste repositório

O plugin Superpowers é habilitado em `.claude/settings.json` (ver ADR 0023). As regras do `AGENTS.md` prevalecem sobre os padrões das skills.

- Specs e planos gerados por brainstorming/writing-plans: salvar em `.ai/plans/`, não em `docs/superpowers/`.
- Decisões arquiteturais resultantes: ADR sequencial em `.ai/decisions/`.
- TDD com Vitest; dados sintéticos; nunca efetuar envios reais ao WhatsApp em testes.
- Worktrees em `.worktrees/`; após criar, executar `pnpm install` (há módulo nativo) e `pnpm test` como baseline.
- Antes de declarar conclusão: `pnpm lint && pnpm typecheck && pnpm test` e relatar a saída real.
- Ao finalizar a branch: atualizar `.ai/context/current-state.md` e respeitar o hook de privacidade em `.githooks/`.
- Repositório público: nenhum dado real (nomes, telefones, IDs, mensagens, caminhos locais) em planos, logs ou fixtures.
