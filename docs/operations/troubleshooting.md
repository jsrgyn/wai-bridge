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

## Extension context invalidated

O Chrome invalida a conexão do content script antigo quando a extensão é
recarregada, atualizada ou desativada. A aba já aberta não recebe automaticamente
um novo contexto por causa dessa recarga.

O content script trata erro síncrono e rejeição de Promise nas chamadas ao runtime,
interrompe observadores/tentativas pendentes e revoga o executor quando detecta
invalidação. Mostra aviso para recarregar a aba, preservando o rascunho e sem
atualização automática da página. Uma resposta atrasada do contexto antigo não
reativa o monitor nem autoriza o envio. Falhas temporárias de entrega, com runtime
válido, continuam com tentativas limitadas e idempotentes.

Para carregar uma correção: recarregue WAI Bridge em chrome://extensions e depois
recarregue a aba do WhatsApp Web. Confira Local agent connected e Monitoring on.
Erros antigos na tela de extensões são históricos; limpe a lista para verificar
se uma nova ocorrência aparece. A versão já invalidada na aba precisa dessa
recarga para ser substituída; capturas durante a interrupção não são garantidas.

## Agente conectado, mas comando MCP não chega (ADR 0015)

Execute whatsapp_status e confira extension, além de status/database. Native
CONNECTED com bridge STALE significa que o transporte está vivo mas a rotina de
comandos não consulta a API; não prova SQLite lento. Confira protocolo 2/build atual.
CONTENT_OUTDATED pede recarga da extensão e depois da aba. CONTENT_UNREACHABLE pede
verificar a aba/script. NO_MONITORED_CONTEXT pede monitor ON e uma conversa aberta
(após reload o WhatsApp pode voltar sem #main). AMBIGUOUS_TABS pede deixar somente
uma aba compatível para o pedido. SEND_DISABLED pede opt-in. READY com ready=true
e lastPollAt recente confirma contexto vivo. EXECUTING com WAITING_USER na fila é
espera do clique manual, não falha de resposta.

Outbox REQUESTED com attempt_count=0 até REQUEST_EXPIRED não chegou ao executor;
consultar esse estado é diferente de tentar enviar novamente. Não repetir UNKNOWN.
Nova ponte responde aceitação sem segurar o canal pela espera manual, continua
consultando cancelamento e não depende de a aba WhatsApp já estar selecionada.
Não usar automação externa da IA para contornar a extensão.
