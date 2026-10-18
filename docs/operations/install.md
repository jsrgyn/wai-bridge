# Instalação local no macOS

O instalador é destinado ao usuário atual e não usa `sudo`. Ele aponta para o checkout do repositório e Node/pnpm já instalados; ainda não existe bundle assinado/notarizado nem instalador gráfico. Use Node 24 LTS–26 e pnpm compatível com o workspace.

## Preparar

1. Confira o checkout e instale as dependências/builds:

   ```sh
   cd /caminho/para/wai-bridge
   pnpm install --frozen-lockfile
   pnpm lint && pnpm typecheck && pnpm test && pnpm build
   ```

2. Carregue `apps/chrome-extension/dist` como extensão unpacked no Chrome para desenvolvimento. Mantenha o ID fixo e copie o ID exibido em `chrome://extensions`. A captura continua experimental; não configure uso em conta real como se estivesse validado.

3. Gere um token local aleatório com pelo menos 32 caracteres e exporte-o no terminal da instalação, junto ao ID:

   ```sh
   export WAI_BRIDGE_EXTENSION_ID='<32 caracteres a-p exibidos pelo Chrome>'
   export WAI_BRIDGE_API_TOKEN="$(openssl rand -hex 32)"
   ```

   Não coloque o token em arquivos do repositório, tickets, screenshots ou logs. A instalação grava o token em `~/Library/Application Support/WaiBridge/host-config.json` com modo 0600; essa configuração não usa Keychain.

4. Prepare os arquivos. Sem argumento, o comando não carrega serviço persistente:

   ```sh
   ./apps/mac-agent/scripts/install-macos.sh
   ```

   Ele compila, cria configuração, launcher do Native Messaging e plist `~/Library/LaunchAgents/com.wai-bridge.local-api.plist`. Os dados ficam em `~/Library/Application Support/WaiBridge/data/`; logs em `~/Library/Logs/WaiBridge/`. O manifesto Chrome fica no caminho padrão NativeMessagingHosts do usuário. Revise todos os arquivos e permissões gerados.

## Ativação opcional

Carregue o LaunchAgent somente quando decidir manter a Local API ativa para esse usuário:

```sh
./apps/mac-agent/scripts/install-macos.sh --load
```

Esse comando chama `launchctl bootstrap gui/<uid>` sem root e usa `RunAtLoad`/`KeepAlive`. A ativação carrega a Local API; não habilita envio real. Reinicie o Chrome para reler o registro do Native Messaging host. Desativar o LaunchAgent é feito por `uninstall-macos.sh`.

O MCP stdio é iniciado separadamente pelo cliente MCP, conforme `packages/mcp-server/README.md`; não é um LaunchAgent.

## Atualização

```sh
./apps/mac-agent/scripts/update-macos.sh
```

Atualiza dependências/build e prepara os artefatos sem reiniciar serviço. Para explicitamente recarregar o LaunchAgent após revisar a mudança:

```sh
./apps/mac-agent/scripts/update-macos.sh --load
```

O caminho do checkout deve permanecer estável porque os launchers apontam para ele. Faça backup antes da atualização; migrações SQLite são aplicadas no próximo início da API.

## Remoção

```sh
./apps/mac-agent/scripts/uninstall-macos.sh
```

Descarrega o LaunchAgent e remove registro/launchers. Banco e dados são mantidos. `--purge` remove a configuração local que contém o token; não apaga o banco. Preserve backups antes de remover manualmente o diretório de dados.
