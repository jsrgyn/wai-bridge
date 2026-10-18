# Recuperação e restauração

## Restaurar banco

1. Escolha um arquivo `.sqlite` confiável criado pelo script de backup; não restaure arquivo recebido de fonte desconhecida.
2. Execute:

   ```sh
   ./apps/mac-agent/scripts/restore-macos.sh --confirm "$HOME/Library/Application Support/WaiBridge/backups/wai-bridge-<timestamp>.sqlite"
   ```

3. O script descarrega o LaunchAgent se estiver carregado, exige `--confirm`, valida integridade e schema 1–8, salva snapshot pre-restore do banco atual e troca o banco por rename atômico. O serviço permanece parado.
4. Rode `diagnose-macos.sh`. Confira integridade/schema. Revise dados restaurados e então execute `install-macos.sh --load` para reativar explicitamente.

Se o processo falhar antes do rename, o banco ativo permanece. O snapshot pre-restore fica em `data/backups/`. Não copie um `.sqlite` sobre banco ativo sem parar a API. Arquivos WAL/SHM antigos são removidos apenas pelo script depois que o LaunchAgent foi descarregado.

## Recuperação de eventos e comandos

Eventos persistidos são reconsultáveis; leases expirados podem ser recuperados pelo dispatcher. Estados `UNKNOWN` do envio não são repetidos automaticamente. Mensagens AI sem ACK são recuperáveis por lease/API. Não edite tabelas SQLite manualmente como rotina.

## Perda de mídia

O banco armazena referências/metadados; blobs ficam no store privado separado. Backup/restore de banco sozinho não restaura bytes de mídia. Como ingestão/backup coordenado não está integrado, classifique mídia como indisponível até existir cópia verificada; não marque `CACHED` manualmente.

## Corrupção ou indisponibilidade

Pare serviço com `uninstall-macos.sh` (ou `launchctl bootout` do usuário), preserve cópia original para análise e restaure uma cópia validada. Se nenhum backup passar `integrity_check`, mantenha o serviço parado e preserve o arquivo corrompido; não recrie banco por cima dele.
