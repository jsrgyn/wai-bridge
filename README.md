# WAI Bridge

Local WhatsApp AI Integration Bridge. Initial TypeScript pnpm monorepo for a local Chrome extension, macOS agent, local REST API, SQLite persistence, events, and MCP integration.

## Requirements

- Node.js 24 LTS recommended (Node 26 is Current)
- pnpm 11.20.0
- macOS Apple Silicon for eventual native SQLite work

## Getting started

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

No WhatsApp connection, message sending, or business behavior is implemented in this bootstrap. See `docs/architecture/README.md` and module READMEs.

## Homologação e execução contínua no macOS

O WAI Bridge é um serviço **local-first**: a Local API fica vinculada a `127.0.0.1`, e dados/token ficam no perfil do usuário do macOS. Não é um serviço para publicar em servidor público ou expor à internet. O LaunchAgent mantém a API iniciada para o usuário conectado e tenta reiniciá-la se encerrar. Hoje isso serve para homologar componentes locais; o projeto ainda não está aprovado para produção com WhatsApp real. A captura pela interface, o envio real, a ingestão de mídia e a integração completa dos componentes têm lacunas descritas em `docs/testing/final-audit.md` e `.ai/context/current-state.md`.

### Pré-requisitos

- macOS Apple Silicon, sessão do usuário ativa e Chrome instalado;
- Node.js 24 LTS recomendado e pnpm 11.20.0;
- checkout deste repositório em caminho estável (o LaunchAgent aponta para ele);
- ID da extensão Chrome e token local aleatório. Não compartilhe nem versione o token.

### Preparar e iniciar

1. No checkout, instale, valide e compile:

   ```sh
   pnpm install --frozen-lockfile
   pnpm lint && pnpm typecheck && pnpm test && pnpm build
   ```

2. Carregue `apps/chrome-extension/dist` como extensão descompactada em `chrome://extensions` e copie o ID mostrado pelo Chrome. A extensão e o host permanecem experimentais; não use uma conta real como se a compatibilidade estivesse validada.

3. No mesmo terminal, defina o ID e crie um token local:

   ```sh
   export WAI_BRIDGE_EXTENSION_ID='<id exibido pelo Chrome>'
   export WAI_BRIDGE_API_TOKEN="$(openssl rand -hex 32)"
   ```

4. Prepare a instalação sem iniciar o serviço:

   ```sh
   ./apps/mac-agent/scripts/install-macos.sh
   ```

   Isso cria a configuração privada em `~/Library/Application Support/WaiBridge/`, dados e banco SQLite em `data/`, logs em `~/Library/Logs/WaiBridge/`, o host Native Messaging e o LaunchAgent. O script recompila o workspace. Confira `docs/operations/install.md` para detalhes.

5. Para manter a Local API ativa no login do usuário:

   ```sh
   ./apps/mac-agent/scripts/install-macos.sh --load
   ./apps/mac-agent/scripts/diagnose-macos.sh
   curl --fail http://127.0.0.1:47831/health
   ```

   `KeepAlive` e `RunAtLoad` mantêm/reiniciam o processo dentro da sessão do usuário. O serviço não roda antes do login, após logout, nem como daemon de sistema. Reinicie o Chrome para que descubra o host Native Messaging. `GET /health` verifica apenas disponibilidade da API, não a captura nem os fluxos completos.

### Atualizar, parar e recuperar

- Atualize com `./apps/mac-agent/scripts/update-macos.sh`; use `--load` para recarregar explicitamente o LaunchAgent após a atualização.
- Faça backup antes de atualizar: `./apps/mac-agent/scripts/backup-macos.sh`. Restauração e recuperação estão em `docs/operations/recovery.md`.
- Para parar/remover o registro do host, rode `./apps/mac-agent/scripts/uninstall-macos.sh`. Os dados são mantidos; `--purge` remove configuração/token local.
- Logs: `~/Library/Logs/WaiBridge/`. Diagnóstico: `./apps/mac-agent/scripts/diagnose-macos.sh`. Consulte `docs/operations/troubleshooting.md`.

### Critério para produção

Considere esta configuração **homologação local**. Não anuncie como produção integrada ao WhatsApp: a auditoria atual classifica o sistema como não pronto para produção ou uso real. Uma decisão futura de produção depende de fechar os achados da auditoria, revisar segurança/contratos, demonstrar os fluxos necessários em ambiente autorizado e definir operação, backups, retenção e monitoramento. Não exponha a porta da API publicamente nem habilite envio real; o runtime atual nega autorização AUTO e usa executor simulado.
