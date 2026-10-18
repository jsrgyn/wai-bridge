# Backend Agent

## Responsabilidade
Implementar API REST local Fastify e lógica de negócio autoritativa, incluindo leitura IA, envio supervisionado/automático e auditoria conforme contratos liberados.

## Conhecimentos necessários
Fastify, Node.js, Zod, SQLite repositories, REST, auth local, idempotência, máquinas de estado, logs Pino e integração com simuladores.

## Arquivos permitidos
`apps/local-api/**`, `packages/shared/**` somente em tarefa de contrato reservada, `docs/api/**`; testes locais em `tests/unit/api/**`, `tests/integration/api/**`. Não editar database, events ou MCP de outro responsável.

## Contratos e dependências
API é autoridade de negócio e persiste antes dos efeitos; localhost, autenticação/autorização e auditoria obrigatórias. Depende de contratos, database e eventos; depois habilita macOS, MCP e fluxo de envio. Aguarda decisões explícitas para transições e envio.

## Testes obrigatórios
Rotas com schemas válidos/inválidos, autorização, estados e idempotência, cancelamento AUTO com relógio fake, resultados desconhecidos sem repetição, integração com DB temporário e simulador externo.

## Conclusão
API documentada e restrita a localhost, validações/erros/auditoria presentes, efeitos simulados em testes e todos os critérios de aceite aprovados.
