# Identificação de conversas — validação em 2026-10-18

Escopo: referências telefônicas observadas e grupos locais confirmados pelo usuário,
conforme ADR 0009. Fluxo administrativo no popup, contexto efêmero na aba, envelope
Zod compartilhado, normalização transacional e consulta MCP. Não há envio real.

## Evidências

| Verificação | Resultado observado |
| --- | --- |
| `pnpm build` | Passou nos nove projetos aplicáveis |
| `pnpm lint` e `pnpm typecheck` | Passaram |
| `pnpm --filter @wai-bridge/chrome-extension typecheck` | Passou, incluindo testes da extensão |
| `pnpm test` | 110 testes em 12 arquivos passaram |
| `pnpm test:integration` | 2 testes host → API → SQLite passaram, sem/com referência de grupo |
| Teste unitário da extensão | 3 testes passaram |
| Playwright da extensão | 23 cenários passaram, incluindo 9 de identidade/popup |
| Smoke temporário dos scripts backup/restore | Schema 8 restaurou uma identidade de grupo, duas mensagens e uma conversa; integrity ok e zero violações FK |
| `git diff --check` | Passou |

Avisos ESM do ESLint/Vite e NO_COLOR/FORCE_COLOR do Playwright continuam presentes.
Na construção dos testes, o primeiro teste de popup falhou por seletor que também
casava “Desvincular”; foi corrigido para correspondência exata e a suíte passou.

## Cobertura relevante

- Telefone internacional explícito, normalização sem inventar dígitos e rejeição de
  telefone oculto/incompleto/ambíguo; checagem de viewport e estilos de ancestrais.
  Envelope com versão/tipo/data incompatíveis rejeitado.
- Mesmo telefone/conta reaproveita contato e conversa através de extension instances;
  outra conta fica separada. Outbound mantém sender null. PARTIAL não passa no
  DatabaseRecipientResolver para envio. Auditoria da associação não contém telefone.
- Grupo com mesmo UUID/conta reaproveita conversa e sequência através de renomeação;
  outro UUID com mesmo nome fica separado. Membros homônimos não são unificados.
- Popup exige conta e confirmação explícita; cadastra referências sem iniciar monitor.
- Navegação, atalho, cabeçalho, raiz substituída ou telefone alterado descartam vínculo;
  token de confirmação antigo é rejeitado. Parar/reiniciar monitor exige reconfirmação.
- Migração 7 → 8 preserva links e integridade ao permitir múltiplas observações por
  conversa. Fallback UNKNOWN e retries anteriores continuam testados.

## Verificação manual limitada

Na aba autorizada pelo usuário, o painel Dados do grupo foi reconhecido com
`group-info-header` dentro de `chat-info-drawer`. Os atributos examinados não
forneceram um ID externo de grupo. Não houve busca de participantes, coleta de
links de convite ou acesso a armazenamento de sessão/protocolos privados.

Após backup `wai-bridge-20261018T044133Z.sqlite`, API local reiniciada e diagnose
confirmou SQLite íntegro/schema 8/API disponível; MCP whatsapp_status confirmou
ok/database connected/schemaVersion 8. Extensão e aba atualizadas no Chrome; popup
verificado com Local agent connected, Monitoring off e novo formulário presente.
Nenhuma conta/grupo real foi cadastrado ou confirmado pelo agente; nenhuma fixture
foi inserida no banco do usuário. Confirmação humana no popup é a etapa de uso.

Isso não comprova estabilidade do DOM nem captura real de ponta a ponta. A ausência
de sinal observável de troca de conversa e erro humano ao selecionar referências
continuam riscos. Identidades permanecem PARTIAL, envio real desabilitado e nenhuma
mensagem antiga é relinkada. Ver [procedimento de uso](../operations/conversation-identification.md).

## Correção da captura na interface atual (2026-10-18)

Inspeção restrita ao DOM visível confirmou bolhas `msg-container` sem as classes
`message-in`/`message-out`, com `msg-meta`, caudas `tail-in`/`tail-out` quando presentes
e wrapper flex em coluna, alinhado em `flex-start` (recebido) ou `flex-end` (enviado).
Nenhum texto ou identificador pessoal foi usado como fixture. O adapter reconhece
esse formato apenas em linhas de `#main`, em LTR e sem cauda contraditória; estrutura
ambígua permanece UNKNOWN. Trata-se de evidência visual experimental, não de API
oficial nem de prova de identidade do remetente.

Novo teste sintético de navegador cobre bolhas montadas em etapas, entrada/saída,
alinhamento ambíguo, cauda contraditória, RTL, remoção antes da captura, edição de
mensagem preexistente e atualização posterior sem duplicação. A captura aguarda
150 ms de estabilidade (máximo de 1 s) para nós recém-inseridos; nós removidos e
edições isoladas de mensagens anteriores são ignorados.

Testes unitários de status cobrem estado persistido on após reload com content
script off, ausência de conversa aberta e content script indisponível. Popup agora
consulta o monitor real da aba ativa, distingue avisos da lista de mensagens e
explica quando é necessário abrir uma conversa ou reiniciar o monitor.

### Rerender e título do contato

A conferência posterior encontrou captura real, mas com identidade UNKNOWN e uma
mensagem duplicada em dois registros, enquanto a UI mostrava uma única bolha.
Deduplicação agora também usa o marcador visível `conv-msg-*`, apenas em cache
local da página, por raiz e limitado a 2000 entradas. Não é uma identidade externa
persistente: reload, outra raiz ou descarte do cache podem permitir nova captura.
Não compara textos nem reúne contatos/históricos. Registros antigos não foram
alterados. O teste troca a linha completa mantendo o marcador, e insere outra
linha com texto igual e marcador diferente, verificando respectivamente supressão
e captura. A extração do título prioriza o nome do chat antes dos tooltips de
controles do cabeçalho. Build, typecheck, lint e 6 unitários/24 Playwright passaram.

## Diálogo de entrada/saída (2026-10-18)

- Dois cenários Playwright (contato/grupo) confirmam vínculo preservado em clique
  manual no botão Enviar sintético e presença online/digitando; entrada → saída →
  entrada mantém conta/contexto. Trocar o título ainda invalida o vínculo.
- Dois cenários API→SQLite→MCP (telefone/grupo) persistem três falas alternadas,
  deduplicam retransmissão e retornam diálogo em ordem crescente com paginação de
  mensagens anteriores. Outra conta com mesmo nome fica fora; saída não inventa
  sender; consultas não alteram UNREAD nem criam outbox.
- Os dois testes Native Host→API→SQLite agora transportam entrada e saída, verificam
  ACKs, persistência e sequência da conversa vinculada. Sem vínculo permanecem
  conversas UNKNOWN distintas, conforme contrato anterior.
- Build, lint, typecheck raiz e typecheck da extensão passaram; 115 testes raiz,
  2 de integração e extensão (6 unitários/26 Playwright) passaram. MCP isolado
  passou 17 testes. Smoke pelo launcher privado instalado descobriu 15 ferramentas,
  incluindo whatsapp_get_dialogue; status real ok/database connected/schema 8.
- Nenhum envio real foi efetuado e não foi executado teste automatizado em conta
  WhatsApp. Nova extensão precisa de recarga e clientes MCP precisam reconectar;
  não foi demonstrado diálogo real identificado/bidirecional com a nova versão.
