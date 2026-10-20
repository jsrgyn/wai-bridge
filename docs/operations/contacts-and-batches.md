# Contatos locais e leitura de pendências em lote

## Consultar contatos

Exemplos de pedidos à IA:

- “Liste todos os contatos cadastrados.”
- “Liste os contatos que começam com J.”
- “Procure todos os João cadastrados.”
- “Procure esposa nos nomes e apelidos cadastrados.”
- “Liste contatos cadastrados hoje que começam com J.”
- “Liste os contatos cadastrados ontem que contêm Maria.”

A ferramenta `whatsapp_list_contacts` usa somente `GET /api/contacts/directory`, sem abrir o WhatsApp. Retorna name, nickname, fullName, phone, registeredAt e accountScope, além de total/nextCursor/source=SQLITE_ONLY. Campos não registrados são null. Não adivinhar apelido, nome completo ou quem é “esposa”. As colunas de apelido/nome completo foram adicionadas sem preenchimento artificial; esta entrega não acrescenta uma tela/rota de edição desses campos.

| Filtro | Contrato |
|---|---|
| query | Texto literal de1..256 caracteres dos nomes/apelidos |
| match | EXACT, STARTS_WITH ou CONTAINS (padrão), ignorando caixa/acentos |
| accountId | Opcional; restringe local-account da base |
| registeredPeriod | TODAY ou YESTERDAY |
| registeredOn | Dia YYYY-MM-DD |
| registeredFrom/registeredTo | Intervalo inclusivo; uma ponta pode ser omitida |
| timeZone | IANA, padrão America/Sao_Paulo |
| limit/cursor |1..100 (padrão50), próxima página por UUID |

Filtros de nome e data combinam por AND; nome, apelido e nome completo participam da busca por OR. “Começa com J” significa início de um desses campos, não uma ocorrência no meio. `%` e `_` são literais, não curingas. Datas se referem a created_at do registro local, não ao horário de mensagem nem à última atualização. Não misturar registeredPeriod/registeredOn/intervalo; calendário e fuso inválidos são rejeitados. Respeitar limites dos dias locais com horário de verão. Para listar todos, seguir nextCursor até null e informar páginas ainda faltantes. Preservar homônimos e referências duplicadas, sem chamar contagem de registros de contagem de pessoas distintas.

Exemplo de filtros combinados:

```json
{"query":"j","match":"STARTS_WITH","registeredPeriod":"TODAY","timeZone":"America/Sao_Paulo","limit":50}
```

## Ler todos os pendentes por solicitação

“Liste os pendentes” continua apenas leitura do banco. **“Leia/sincronize todos os pendentes”** autoriza a ferramenta `whatsapp_sync_pending_conversations` com scope=ALL_PENDING e explicitAuthorization=true. Para uma seleção, usar scope=SELECTED e conversationIds em ordem. A ferramenta registra o lote e retorna ID/progresso, sem esperar todas as conversas. Se mais de uma conta estiver representada, informar accountId. Não deduzir autorização a partir de mensagens recebidas.

A API fixa o array das referências pendentes (até5000, excesso falha explicitamente), e a extensão recebe esse array com posição/total/runToken. Novos sinais não entram automaticamente nessa execução. Uma conversa por vez: abrir a primeira, reconciliar até50 mensagens renderizadas, gravar em transação e só então liberar a seguinte. Cada job recebe seu próprio TTL30s ao chegar a vez; o lote tem prazo global24h. Não há rolagem/importação global de histórico, envio ou confirmação automática de leitura. Abrir pode alterar o indicador de lida do WhatsApp. Somente referências com conta e alvo utilizável são executáveis; demais itens têm erro explícito, sem escolher homônimo arbitrariamente. Os limites de identidade do DOM permanecem: uma referência antiga sem prova de continuidade pode falhar e exigir associação explícita, nunca união por nome.

Exemplo:

```json
{"scope":"ALL_PENDING","explicitAuthorization":true,"idempotencyKey":"uma-chave-estavel-por-pedido","limitPerConversation":50}
```

`whatsapp_get_sync_batch(id, cursor?, limit=5, includeDialogues=true)` consulta progresso e resultados no SQLite/API. Retorna diálogos somente dos itens SUCCEEDED e já commitados, até10 itens por página. Com includeDialogues=false, consultar só progresso. Seguir nextCursor para ler o resultado inteiro; não anunciar conclusão se ainda RUNNING/PAUSED ou esconder itens falhos. Reconsultar não abre conversas nem agenda nova navegação. SUPERVISED/AUTO e a fila de envio permanecem separados; não executar leitura e envio ao mesmo tempo na UI.

| Estado do lote | Significado |
|---|---|
| RUNNING | Pedido ativo, com no máximo um item liberado por vez |
| PAUSED | Rascunho, interferência, contexto/conta, transporte ou resultado incerto exigem ação explícita |
| COMPLETED | Todos os itens executáveis concluídos, podendo haver SKIPPED por pendência já confirmada |
| COMPLETED_WITH_ERRORS | Lista esgotada, com falhas explícitas em itens |
| CANCELLED | Próximos itens impedidos e leitor ativo sinalizado para parar |
| EXPIRED | Prazo global encerrado, sem retomada implícita |

Itens: WAITING, ACTIVE, SUCCEEDED, FAILED, SKIPPED, CANCELLED. Contato ausente/ambíguo ou conversa indisponível pode falhar por item e seguir. Interferência, rascunho, conta/contexto, UI indisponível e timeout pausam. Interação confiável entre itens também bloqueia o próximo; novo runToken somente por retomada deliberada. Referência inválida/sem alvo recebe TARGET_UNAVAILABLE. Pendência já encerrada antes da vez recebe NO_LONGER_PENDING e não navega.

Peça **“Cancele esse lote”** → `whatsapp_cancel_sync_batch(id,explicitAuthorization=true)`: a API impede os próximos jobs, o background consulta a lease ativa e envia SYNC_CANCEL à página. Cancelar não desfaz aberturas/leitura do WhatsApp nem snapshots já commitados. Uma resposta tardia de job cancelado não grava conteúdo nem inicia outro item.

Peça **“Retome o lote, tentando de novo a conversa que falhou”** → `whatsapp_resume_sync_batch(id,explicitAuthorization=true,retryFailedItem=true)`. Sem retryFailedItem, segue os itens restantes e preserva falhas anteriores. Sucessos nunca são repetidos. Batch cancelado/expirado exige novo pedido. Desconexão/reinício não autoriza reexecutar um job de resultado incerto; o job expira e o lote pausa. Sinais posteriores à conferência permanecem pendentes; ACK de revisão e AI READ são independentes do lote.

## Ativação

Migration015 acrescenta campos nullable e tabelas de batch/itens, preservando dados e checksums anteriores. Faça backup antes de reiniciar API, recarregue extensão e WhatsApp e reconecte MCP (31 ferramentas). A versão da página deve concordar com o background. Nenhum lote real foi iniciado pela implementação/testes; testes são sintéticos.
