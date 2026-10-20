# ADR0022 — Proteção de privacidade no repositório público

Data: 2026-10-19. Estado: Accepted.

## Contexto

O projeto é público e contém código da extensão, API local, agente macOS e servidor MCP. Arquivos de configuração, bancos, capturas, logs, mídia, credenciais e metadados de autoria podem expor dados privados quando adicionados ao Git. A documentação operacional também pode revelar nomes, caminhos locais ou informações de uma conta real.

## Decisão

- Manter as regras de privacidade explícitas em `AGENTS.md`, `.ai/rules/security.md` e `docs/security/threat-model.md`; tratar qualquer conteúdo real do WhatsApp como dado privado e não confiável.
- Ignorar no Git configurações locais, dados privados/de runtime, capturas e artefatos de diagnóstico/binários que não pertencem ao código-fonte.
- Usar hook local de pre-commit (`.githooks/pre-commit`) para exigir identidade Git pseudônima neste checkout, bloquear caminhos/formatos sensíveis staged e executar Gitleaks sobre as mudanças staged com redação de segredos.
- O hook é configurado por checkout via `core.hooksPath`; cada clone deve instalar/configurar Gitleaks e ativar o hook seguindo o README. `.gitignore` sozinho não é uma barreira de segurança.
- Documentação versionada registra somente arquitetura genérica e validações sintéticas. Não inclui dados reais de usuários, conversas, contas, caminhos absolutos nem identidade pessoal.
- Não reescrever automaticamente histórico Git publicado. Achados no histórico antigo exigem análise e coordenação separadas, porque a reescrita altera os hashes e cópias remotas.

## Alternativas consideradas

- Confiar somente em `.gitignore`: rejeitado, pois arquivos podem ser adicionados com `git add -f` e segredos também podem aparecer em arquivos permitidos.
- Depender apenas de revisão manual: rejeitado como controle único, pois é fácil deixar passar credenciais ou artefatos binários.
- Reescrever nesta tarefa todo o histórico publicado: rejeitado; não é uma alteração local reversível e demanda coordenação com colaboradores e cópias remotas.

## Consequências

- O repositório passa a ter verificações preventivas locais antes do commit e documentação para replicá-las em novos clones.
- A detecção de segredos depende de Gitleaks instalado e não substitui revisão humana; falsos positivos podem exigir substituição da fixture ou uma exceção estreita, documentada e revisada.
- Hooks locais podem ser ignorados por configuração explícita do Git; revisão de PR e proteção do host continuam necessárias.
- A limpeza dos arquivos atuais não remove metadados ou conteúdo já existente em commits publicados. O estado desse histórico deve permanecer explícito até uma decisão coordenada de remediação.

## Evidências da implementação

- O hook foi exercitado em repositório temporário: fixture sintética segura passou; caminho privado e chave sintética staged foram bloqueados/detectados.
- A varredura Gitleaks da árvore de trabalho atual não encontrou achados. Uma varredura do histórico antigo encontrou falsos positivos em fixtures sintéticas e metadados de autoria existentes; esses commits não foram reescritos.
- Na atividade, `pnpm lint`, `pnpm typecheck`, typecheck da extensão, `pnpm build`, `pnpm test` (233 testes/30 arquivos), `pnpm test:integration` (9 testes/6 arquivos) e o Playwright do executor de outbox (11 testes) terminaram com sucesso.
- O README foi expandido com arquitetura/fluxograma, build, configuração e operação da extensão, API e MCP, comandos de teste e referências de segurança.
