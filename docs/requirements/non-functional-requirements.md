# Requisitos não funcionais

- NFR-01: arquitetura local-first, sem banco externo; API restrita a localhost.
- NFR-02: TypeScript strict, módulos coesos, responsabilidades separadas e dependências justificadas.
- NFR-03: contratos em fronteiras validados com Zod; erros explícitos e logs estruturados sem dados pessoais desnecessários.
- NFR-04: código testável; testes determinísticos com mocks/fixtures sintéticos e sem envios reais.
- NFR-05: menor privilégio para processos, ferramentas, arquivos, destinatários e operações.
- NFR-06: proteger credenciais fora do código e proteger arquivos locais de banco, mídia e configuração.
- NFR-07: política de retenção configurável; avaliar criptografia quando apropriada.
- NFR-08: não declarar cobertura integral de captura; comunicar indisponibilidade ou incerteza.
- NFR-09: preservar cancelamento e evitar repetição automática após resultado de envio desconhecido.
- NFR-10: compatibilidade alvo com macOS Apple Silicon, Node.js LTS, pnpm e Chrome Manifest V3, com versões verificadas na adoção de dependências.
