# Validação de resolução de destinatário (FR-15)

1. Recarregue WAI Bridge em chrome://extensions e depois recarregue WhatsApp Web.
   Monitor ON, agente conectado, permissão de comandos de envio marcada.
   Reconecte MCP no cliente para descobrir whatsapp_send_to_contact.
2. Abra uma conversa. A extensão limpa a pesquisa ao começar. Não edite o perfil.
   O painel normal pode permanecer aberto, inclusive com switch de notificações.
3. Peça à IA: “Use o wai-bridge para preparar para esposa, modo SUPERVISED,
   texto TESTE-ENVIO-02”. Isso só funciona se o nome corresponder ao SQLite e
   houver um telefone único cadastrado na conta ativa. A ferramenta é
   whatsapp_send_to_contact. Sem telefone/nome, informe o número internacional
   completo e use whatsapp_send_to_number. Não adivinhar parentesco ou dígitos.
4. O retorno inicial é QUEUED com ID. Volte ao Chrome/WhatsApp: a extensão
   deve localizar a conversa, abrir perfil, conferir telefone e preparar texto.
   O status vai a DRAFTED, sem mensagem enviada. Consulte o status pelo ID no MCP.
   Sem aba utilizável o pedido fica em WAITING_WHATSAPP.
5. Confira destinatário/texto. Só clique Enviar se quiser fazer esse teste real.
   Depois consulte status: SENT requer evidência visível; UNKNOWN não deve ser
   reenviado automaticamente. A captura normal registra a saída observável.
6. Consulte whatsapp_search_contacts pelo número: nome/telefone devem estar
   registrados após prova do perfil, inclusive quando não estavam no SQLite
   antes. Registro local não é cadastro na agenda do celular. Consulte as
   conversas pelo telefone e recupere diálogo no UUID observado; não presumir
   fusão de históricos anteriores.
7. Repita com outro número explicitamente autorizado ainda ausente no SQLite.
   Se não houver conversa, a busca tenta Nova conversa. Falta de resultado,
   múltiplos resultados, grupo ou telefone divergente devem falhar sem envio.
   Não há garantia de localizar qualquer número sem resultado acessível na UI.
8. Em ambiente sintético, validar nomes iguais com números diferentes (bloqueio),
   outra conta (isolação), perfil em edição (preserva), campo oculto/checkbox
   (não bloqueia fechamento), aba oculta (não reivindica), idempotência após
   rename/expiração (mesmo comando) e prova de perfil divergente (sem cadastro).

AUTO continua exigindo pedido explícito, opt-in e contagem cancelável
configurável (padrão 5 s, 0–30 s); SUPERVISED nunca clica Enviar e termina em
DRAFTED. Pedidos na fila expiram pelo tempo máximo configurado (padrão 30 min,
ou sem limite) e a lease de execução segue o tempo configurado (padrão 60 s). Cobertura de captura global de
conversas fechadas permanece parcial (FR-13).

## Regressão: grupos em comum na busca

Com uma conversa individual e grupos em comum aparecendo no mesmo resultado,
preparação deve selecionar a conversa e ignorar as seções Grupos em comum e
Mensagens. A presença desses grupos não é ambiguidade de destinatário. Dois
contatos candidatos reais, inclusive nomes iguais, ainda bloqueiam. Resultado
anterior visível durante carregamento não pode ser escolhido. Regressões
sintéticas PT/EN, carregamento atrasado/busy, somente grupos e perfil divergente
estão em search-results.spec.ts; não fazem envios reais.

## Entrega responsiva e cancelamento

Após recarregar extensão/WhatsApp, abra uma conversa para estabelecer o contexto.
Execute whatsapp_status: protocolo 2, build preenchido, bridge READY e ready=true.
Fechar a conversa deve informar NO_MONITORED_CONTEXT; desconectar/aba sem resposta
não pode continuar aparecendo como ponte pronta apenas porque SQLite está conectado.

Em teste real explicitamente autorizado, solicitar SUPERVISED deve retornar intenção
sem aguardar clique. Havendo outra aba selecionada, uma única aba compatível
do WhatsApp pode vir à frente. Para cancelar, use o MCP enquanto o pedido está em
QUEUED/WAITING_WHATSAPP (ou AUTO em WAITING_AUTO_SEND) e verifique CANCELLED sem
clicar Enviar; DRAFTED é terminal e não prende pedidos posteriores. Nunca repetir UNKNOWN. Testes automatizados usam somente fixtures, inclusive
ativação de abas/janelas simuladas e observação persistida bloqueada artificialmente.
