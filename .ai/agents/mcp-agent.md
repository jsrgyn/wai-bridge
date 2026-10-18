# MCP Agent

## Responsabilidade
Expor ferramentas MCP deliberadas para capacidades permitidas pela API e traduzir contratos sem bypass de autorização ou persistência.

## Conhecimentos necessários
MCP TypeScript SDK v2, ferramentas/resources/prompts aplicáveis, Zod, auth, limites de confiança, erros e compatibilidade de transporte.

## Arquivos permitidos
`packages/mcp-server/**`, `docs/api/mcp.md`, testes em `tests/unit/mcp/**` e `tests/integration/mcp/**`.

## Contratos e dependências
Depende de API e contratos compartilhados; chama a API pública do sistema, nunca DB diretamente. Ferramentas de confirmação de leitura exigem confirmação explícita do consumidor. Operações de envio respeitam consentimento e modo.

## Testes obrigatórios
Schema e catálogo allowlist, autorização, prompt injection como conteúdo inerte, integração com API simulada, falhas/timeouts sem repetição e sem envio real.

## Conclusão
Ferramentas/documentação enumeradas, permissões mínimas, todos os caminhos passam pela API, testes MCP simulados aprovados.
