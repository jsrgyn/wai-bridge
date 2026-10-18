# Diagnóstico e solução de problemas

Execute sem ativar serviço:

```sh
./apps/mac-agent/scripts/diagnose-macos.sh
```

O script mostra presença de Node/pnpm, plist, estado do LaunchAgent, manifesto Native Messaging, permissões do arquivo de configuração, `integrity_check`, schema e `/health`. Ele não imprime token.

| Sintoma | Verificações |
| --- | --- |
| API health indisponível | Veja `~/Library/Logs/WaiBridge/local-api.stderr.log`; confira LaunchAgent carregado, Node absoluto no launcher, token em config e porta 47831. |
| `401` na API/MCP | Confirme que API, config do Native Host e cliente MCP receberam o mesmo token; não copie token para saída pública. |
| Chrome não encontra host | Confirme manifesto em `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.wai_bridge.mac_agent.json`, `allowed_origins` e caminho absoluto executável; reinicie Chrome. |
| Host desconecta | Veja stderr do host/API; confirme Native Messaging framing e API local. O host atual só faz status/captura, não entrega comandos do outbox. |
| Migração falha | Pare API, preserve DB e logs, confira espaço/permissões e checksum de migration. Não altere uma migration já aplicada; restaure backup válido ou escale revisão. |
| SQLite ocupado/corrompido | Aguarde chamadas terminarem; execute diagnóstico/backup. Não remova WAL enquanto API estiver ativa. Para corrupção, siga recovery. |
| Mídia sem bytes | A API não possui rota integrada de ingestão/download; metadados não significam bytes disponíveis. |
| Comando AUTO não envia | Esperado: runtime padrão nega autorização e executor é simulado. Não tente habilitar contra WhatsApp real. |
| Estrutura UI não reconhecida | A fixture é sintética; integração real não está validada. Não tente contornar controles nem usar APIs internas. |

Logs Fastify redigem body/URL/token, mas logs locais podem crescer sem rotação automática. Proteja diretório, monitore espaço e aplique retenção manual até uma política de rotação ser implementada.
