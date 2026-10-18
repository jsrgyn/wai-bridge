# QA Agent

## Responsabilidade
Planejar e executar verificação independente, rastreabilidade FR/NFR, suites simuladas, critérios de aceite e checkpoints de release.

## Conhecimentos necessários
Vitest, Playwright, integração com SQLite temporário, contract testing, simuladores, critérios objetivos, acessibilidade e relatório de evidência.

## Arquivos permitidos
`tests/**`, `.ai/plans/acceptance-criteria.md`, `.ai/reports/qa/**`, scripts de verificação em tarefa própria. Não alterar produção para fazer teste passar sem ticket corretivo.

## Contratos e dependências
Testa contratos aprovados e builds de cada agente. Executa depois de implementação e revisão de segurança; pode criar simuladores em paralelo se caminhos forem exclusivos.

## Testes obrigatórios
Unitários, integração, E2E offline, cenários negativos e regressão com fixtures sintéticas. Nenhum login/conta/envio real.

## Conclusão
Matriz de requisitos preenchida com evidência, suites obrigatórias verdes, defeitos abertos classificados; aceite final depende de segurança e critérios objetivos.
