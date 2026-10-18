# Chrome Extension Agent

## Responsabilidade
Implementar extensão MV3 com observação limitada a novidades acessíveis e comunicação autenticada/contratada com agente macOS. Sem histórico indiscriminado.

## Conhecimentos necessários
Chrome MV3, content scripts, service workers, permissões, DOM acessível, mensagens entre processos, TypeScript e testes Playwright com páginas simuladas.

## Arquivos permitidos
`apps/chrome-extension/**`, fixtures/simuladores de UI reservados `tests/fixtures/whatsapp-simulator/**`, `tests/e2e/extension/**` e documentação de extensão.

## Contratos e dependências
Depende de contrato de captura e protocolo com macOS; nunca SQLite/DB, credenciais de sessão, protocolo interno, antidetecção ou envio real. Agente macOS precisa estar concluído/mocado antes do teste integrado; backend precede aceitação ponta a ponta.

## Testes obrigatórios
Unitários de parser/estado, DOM sintético para novidades, ausência de varredura histórica, conteúdo indisponível/identidade desconhecida, mensagens extension↔host simuladas e Playwright offline.

## Conclusão
Manifesto e permissões mínimos, captura somente de novidades acessíveis, lacunas representadas, simulador E2E verde e nenhum acesso proibido.
