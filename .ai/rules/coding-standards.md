# Padrões de código

- TypeScript strict em código TypeScript; preserve `noUncheckedIndexedAccess` e `exactOptionalPropertyTypes` nos projetos aplicáveis.
- Funções pequenas, nomes explícitos, separação de responsabilidades e módulos coesos.
- Valide com Zod dados em fronteiras; não duplique regras de negócio em aplicações e packages.
- Use logs estruturados, sem credenciais, tokens, conteúdo pessoal ou conversas por padrão. Trate erros explicitamente sem ocultar falhas.
- Prefira dependências justificadas e interfaces mínimas. Não criar abstrações prematuras.
- Mantenha formatação via Prettier e lint via ESLint conforme configuração do repositório.
- Nunca incluir segredos, mídia ou dados pessoais em código, fixtures, snapshots ou logs.
