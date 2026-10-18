# Fluxo de envio

## Estado implementado

`packages/outbox-engine` implementa o fluxo persistido `REQUESTED → QUEUED → CLAIMED → TARGET_VERIFIED → COMPOSED`. SUPERVISED termina em `WAITING_USER`; AUTO exige verificador de autorização independente, grava `WAITING_AUTO_SEND`, espera cinco segundos canceláveis, adquire lease exclusivo da interface, grava `SENDING` e só então invoca o executor injetado. Todo avanço é registrado em `wa_outbox_history` e `wa_audit_log`.

A Local API inicia o dispatcher em modo seguro: `DenyAutoAuthorizationVerifier` e `SimulatedSendExecutor`. Assim, pedidos SUPERVISED chegam a `WAITING_USER`; pedidos AUTO falham por falta de autorização independente. Nenhum adaptador WhatsApp real existe nesta fase. O executor simulado é usado em testes e nunca representa envio real. Resultado supervisionado `SENT` exige referência de evidência.

## Regras de recuperação e cancelamento

- `CLAIMED` com lease expirado volta a `QUEUED`.
- `SENDING` com lease expirado vira `UNKNOWN`; não é repetido.
- AUTO interrompido por reinício em `WAITING_AUTO_SEND` vira `CANCELLED`.
- Cancelamento durante a espera aborta o timer. A partir de `SENDING`, cancelamento é recusado porque o resultado externo pode ser incerto.
- Uma lease persistida serializa a única interface de envio entre workers/processos.
- Cada `dispatchOne()` manipula no máximo um pedido; não há envio em massa.

## Contratos futuros

Uma implementação de envio real requer interface autorizada suportada e origem confiável de autorização explícita do usuário. Conteúdo de mensagem recebida nunca fornece autorização. Sem resultado observável/evidência, registrar `UNKNOWN`, sem retry automático.

## Executor da extensão (simulador)

`apps/chrome-extension/src/commands/outbox-executor.ts` implementa os controladores de resolução, verificação de destinatário, composição, contagem regressiva, cancelamento e verificação do resultado. Os adaptadores incluídos operam somente com marcadores `data-wai-*` da fixture; o service worker não instala nem chama esse executor. AUTO está bloqueado por flags locais padrão `false`, requer autorização explícita, revalida a mesma conversa após a contagem e só considera `SENT` com marcador sintético associado ao ID do comando. SUPERVISED preenche o campo e aguarda uma verificação posterior, sem clicar em enviar.

Ainda não existe mensagem de comando/resultados no protocolo Native Messaging nem API no Mac Agent para buscar/atualizar o outbox. Por isso a persistência é um contrato injetado e o executor não está conectado ao SQLite. A validação de compatibilidade com WhatsApp Web real não foi feita; seletores DOM visíveis são não oficiais e instáveis. Nenhum endpoint interno, protocolo privado ou credencial é utilizado.
