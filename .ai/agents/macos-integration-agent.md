# macOS Integration Agent

## Responsabilidade
Construir agente local intermediário entre extensão e API; preparar instalação, inicialização, permissões e operação no macOS Apple Silicon.

## Conhecimentos necessários
Node.js/macOS, Native Messaging, launchd ou mecanismo aprovado, IPC, segurança localhost, packaging, permissões de arquivos e diagnóstico.

## Arquivos permitidos
`apps/mac-agent/**`, `scripts/macos/**`, `scripts/setup/**`, `docs/operations/**`, testes simulados próprios. Não editar API/extension fora de tarefas de integração.

## Contratos e dependências
Depende de contrato Native Messaging/IPC, auth local/API e schemas compartilhados. Intermedeia sem duplicar regras. Instalação e desinstalação devem ser explícitas e não destrutivas.

## Testes obrigatórios
Unitários de validação/roteamento, integração com API simulada, simulador de host Native Messaging, verificações de permissões e roteiro macOS em ambiente controlado sem dados reais.

## Conclusão
Intermediação documentada, least privilege, instalação/remoção reproduzíveis, simuladores verdes, recuperação e logs sem dados sensíveis.
