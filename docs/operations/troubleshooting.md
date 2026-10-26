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
e lastPollAt recente confirma contexto vivo. Pedidos antigos em WAITING_USER aparecem
como COMPOSED; o fluxo atual não espera clique manual (SUPERVISED termina em DRAFTED).

Pedido QUEUED/WAITING_WHATSAPP com attempt_count=0 até REQUEST_EXPIRED (tempo
máximo de espera configurado) não chegou ao executor; consultar esse estado é
diferente de tentar enviar novamente. Fila pausada com INTERRUPTED volta no próximo
poll READY; o pedido interrompido antes de SENDING é retomado na mesma posição.
DRAFT_PENDING_ON_TARGET: AUTO encontrou rascunho pendente no campo do contato;
envie ou apague o rascunho e peça de novo. Não repetir UNKNOWN.
Nova ponte responde aceitação sem segurar o canal, continua
consultando cancelamento e não depende de a aba WhatsApp já estar selecionada.
Não usar automação externa da IA para contornar a extensão.

## Envio: pedido preso em `CLAIMED` e incompatibilidade de versões

Causa comum: o código foi atualizado sem reiniciar a Local API (ADR 0025). Primeiro rode `scripts/restart-local-services.sh --check`; se imprimir "reinício necessário", rode `scripts/restart-local-services.sh`, recarregue a extensão e a aba do WhatsApp Web e reinicie o cliente MCP.

| Sintoma / código | Significado e ação |
| --- | --- |
| Pedido preso em `CLAIMED` | A API antiga reivindicou o pedido, mas a extensão não executou. Rode `--check` e reinicie. Com a API atual, `CLAIMED` sem aceite por 20 s volta a `QUEUED` (`EXTENSION_NO_ACK`); o lease expirado antes de `SENDING` também reenfileira. |
| `API_OUTDATED` | O agente macOS ou o painel recebeu de uma API anterior uma resposta incompatível com o protocolo 3. Uma API antiga costuma responder `400 VALIDATION_ERROR` ao poll de protocolo 3, mapeado para `API_OUTDATED`; o flow log `API_CONTRACT_MISMATCH` só aparece quando o formato da resposta do poll é incompatível. Visível nos logs do agente e da extensão e no aviso do painel; não é gravado no pedido. Reinicie a API com o script. |
| `CLIENT_OUTDATED` | A API recusou o poll porque o agente macOS (native host) ou a extensão está desatualizado (protocolo diferente do 3). Nenhum pedido é reivindicado. Rode `pnpm build`, reinicie ou reinstale o native host (fechar o Chrome ou recarregar a extensão o reinicia), recarregue a extensão em `chrome://extensions` e a aba do WhatsApp Web. Jobs em andamento de um cliente desatualizado após uma atualização são reenfileirados ou marcados `UNKNOWN`, pois o lease não é renovado em polls `CLIENT_OUTDATED`. |
| `API_UNAVAILABLE` / `CONTENT_UNREACHABLE` com API saudável | API nova e extensão nova com agente macOS antigo: o host antigo rejeita localmente o poll de protocolo 3 (ou o campo novo `reason`), e a extensão só vê `API_UNAVAILABLE` ou `CONTENT_UNREACHABLE` enquanto a API responde normalmente. Em `/api/status` a ponte aparece `STALE`/`UNSEEN`. Rode `pnpm build`, reinicie ou reinstale o native host (fechar o Chrome ou recarregar a extensão o reinicia), recarregue a extensão e a aba do WhatsApp Web. |
| `EXTENSION_NO_ACK` | A extensão não confirmou `ACCEPTED` em 20 s; o pedido voltou a `QUEUED` e a fila foi pausada só até o próximo poll READY (segundos). Se o aceite continuar falhando, o mesmo pedido repete o ciclo `CLAIMED` → 20 s → `QUEUED`, registrando `EXTENSION_NO_ACK` a cada volta; cancele-o pelo painel se repetir. Confira se a aba está aberta, o contexto da extensão não foi invalidado e o agente macOS está em execução. |
| Painel com `NOT_FOUND` / "API local desatualizada" | Rotas novas ausentes na API em execução. Reinicie a API com o script. |
