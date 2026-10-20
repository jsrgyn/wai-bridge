# Visão do projeto

WAI Bridge é um software experimental, local-first, que conecta observações autorizadas da interface visível do WhatsApp Web a uma API REST local e a ferramentas MCP. O workspace contém uma extensão Chrome Manifest V3, agente macOS Native Messaging, API Fastify, persistência SQLite, contratos compartilhados com Zod e servidor MCP por stdio.

O sistema oferece captura incremental do que a interface renderiza, reconciliação de uma conversa quando solicitada, fila de pendências, diretório local de contatos, políticas de lote e painel operacional. A captura não equivale a histórico completo; conteúdo e marcadores da interface permanecem dependentes da versão do WhatsApp Web. Operações de envio continuam protegidas por autorização/gates e o runtime local não deve ser tratado como integração de envio de produção.

Todo dado é mantido localmente por padrão. A extensão não abre o SQLite; o agente apenas encaminha envelopes validados; API aplica regras e persiste; MCP chama somente a API autorizada. Conteúdo de mensagens é dado não confiável, não instrução para o sistema.

Consulte `README.md` para build, configuração e operação; `.ai/context/technical-stack.md` para tecnologias; `.ai/context/current-state.md` para implementação e validações verificadas; `.ai/rules/` e `docs/requirements/` para contratos/regras. Não registrar informações pessoais ou detalhes de execução de uma conta nos documentos do repositório público.
