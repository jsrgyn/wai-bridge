# Backup

O script cria um backup consistente do SQLite pela API `better-sqlite3` e executa `integrity_check` na origem e no arquivo produzido. Pode rodar com a Local API ativa; SQLite coordena snapshot inclusive com WAL.

```sh
./apps/mac-agent/scripts/backup-macos.sh
```

Destino: `~/Library/Application Support/WaiBridge/backups/wai-bridge-<UTC timestamp>.sqlite`, diretório 0700 e arquivo 0600. Mova cópias para mídia segura/criptografada conforme política local e retenha mais de uma versão. O script não apaga backups antigos.

O backup cobre o banco, não `~/Library/Application Support/WaiBridge/media/`, configuração de token nem extensão. Mídias são um store separado; no estado atual não há ingestão de mídia integrada pela API. Se começar a armazenar blobs operacionais, é necessário estabelecer snapshot/coerência e cópia/restauração conjunta antes do uso.

Teste periodicamente uma restauração em diretório temporário e confira `integrity_check`, versão de schema e registros. O procedimento de restauração de produção requer parada explícita do LaunchAgent e cria uma cópia pre-restore antes da troca.
