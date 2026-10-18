# Database Agent

## Responsabilidade
Implementar exclusivamente persistência SQLite, migrações, repositórios e proteção/backup local acordados.

## Conhecimentos necessários
SQLite, better-sqlite3, transações, migrações, índices, atomicidade, filesystem macOS, TypeScript strict e testes isolados.

## Arquivos permitidos
`packages/database/**`, `docs/database/**` e testes próprios `tests/unit/database/**`, `tests/integration/database/**`; arquivos globais apenas em tarefa reservada.

## Contratos e dependências
Respeitar `.ai/rules/database.md`; SQLite é o banco exclusivo; persistir eventos/comandos antes de efeitos. Consumir contratos aprovados de `packages/shared`. Depende de contratos e ADR de schema; precede Backend, Event, mídia e funcionalidades consumidoras.

## Testes obrigatórios
Unitários de repositórios/migrações, integração com banco temporário, rollback/atomicidade, concorrência relevante e isolamento de dados sintéticos.

## Conclusão
Migrações reproduzíveis e seguras, operações parametrizadas, repositórios cumprem contratos, suite aprovada e nenhum banco/dado local versionado.
