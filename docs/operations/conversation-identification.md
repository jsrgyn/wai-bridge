# Identificação local de contatos e grupos

Automatic visible-context capture now runs without manual binding when monitoring is ON.
Monitoring intent survives page reload. Manual references below remain optional.
See [automatic capture and its coverage limits](autonomous-capture.md). This does not guarantee account-wide capture or identity continuity after reload.


A identificação é experimental e exige confirmação explícita no popup. Não usa
credenciais, dados de sessão, APIs internas, links de convite nem hashes de perfis.
Vínculo confirmado não inicia monitoramento nem autoriza envio.

## Primeira configuração

1. Após atualizar, recarregue WAI Bridge em `chrome://extensions` e recarregue a
   aba WhatsApp Web para receber o content script novo. Mantenha Monitoring off.
2. No popup, crie uma **Conta local**, por exemplo um apelido para a conta conectada.
   Ela recebe um UUID. Use o mesmo cadastro nas próximas conversas dessa conta;
   cadastrar outra conta cria um escopo separado. A extensão não descobre a conta
   real por armazenamento de sessão; cabe ao usuário conferir a correspondência.
3. Abra manualmente uma conversa e os seus dados pelo cabeçalho.
4. No popup, clique **Conferir conversa aberta**. Se a página estiver incompleta ou
   ambígua, nenhuma identidade é assumida.

## Contato individual

O painel Dados do contato precisa mostrar exatamente um telefone internacional
completo e isolado. O popup mostra a referência encontrada. Confirme a conta e o
telefone e clique **Vincular conversa atual**. Espaços, parênteses e hífens são
removidos; país, DDD ou dígito adicional nunca são adivinhados.

Novas mensagens com esse vínculo passam a usar a mesma conversa e o mesmo contato
por conta local + telefone, mesmo após renomeação do contato. Contato fica PARTIAL,
pois telefone observado não prova identidade humana permanente nem posse do número.
Mudança de número não une automaticamente históricos. Outbound não cria sender self.

## Grupo

Abra Dados do grupo e clique **Conferir conversa aberta**. Crie um **novo grupo
local** com um apelido ou selecione um grupo já cadastrado. Confira visualmente
que o cadastro selecionado corresponde ao grupo aberto e confirme o vínculo.

Cada grupo local recebe UUID próprio. Dois grupos com nome igual podem e devem
ter cadastros distintos. Ao reabrir o mesmo grupo, selecione o mesmo cadastro e
confirme novamente; nome/foto/membros não fazem associação automática. Renomear
não muda o UUID. Para corrigir o apelido, use o código existente na recuperação
de grupo e informe o novo nome, em vez de criar outra identidade.

O cadastro é salvo primeiro no navegador; os registros do banco são materializados
na primeira observação vinculada. O grupo fica PARTIAL com fonte USER_GROUP,
explicitamente um vínculo local, sem alegar ID oficial WhatsApp. Participantes
continuam desconhecidos quando só há nomes, evitando misturar homônimos.

## Duração e descarte do vínculo

O vínculo ativo só existe na memória da aba. Mantenha o painel de dados aberto.
Clique fora do compositor/botão Enviar reconhecido, atalho/navegação, mudança do título da conversa, troca de raiz,
aba oculta, reload ou parada do monitor descartam a confirmação. No cabeçalho reconhecido, atualizações de online/digitando não descartam o vínculo.
Cabeçalhos sem título reconhecido mantêm a invalidação conservadora. O popup pode
consultar se há vínculo ativo; **Desvincular conversa atual** permite descartá-lo.

Depois de confirmar, iniciar o monitor continua sendo ação separada. Só nós novos
são observados. Se o contexto não puder ser confirmado, a observação segue como
UNKNOWN, isolada conforme ADR 0008. Nenhum histórico antigo é percorrido ou reunido.

## Backup e recuperação dos cadastros

Contas e grupos escolhidos ficam no `chrome.storage.local`; o backup SQLite sozinho
não cobre essas preferências. Preserve os códigos e o perfil do navegador em cópia
privada. Em consultas MCP, conversas vinculadas retornam `localAccountId`,
`identitySource` e `externalId` local (`GROUP_LOCAL:<UUID>` ou `PHONE:<telefone>`).

Após perder as preferências, expanda **Recuperar conta já cadastrada**, informe o
UUID da conta e um apelido. Para grupos, informe apenas o UUID após `GROUP_LOCAL:`
em **Recuperar grupo já cadastrado**, com a mesma conta local, e confira o grupo
aberto novamente. Reutilizar um código não valida automaticamente o grupo atual;
confirmação continua obrigatória. Códigos de conta/grupo diferentes não são unidos.

Essa recuperação não revela dados de sessão. Também não fornece prova absoluta
de estabilidade da interface: alteração sem sinal observável e erro humano ao
selecionar conta/grupo continuam riscos. Ver ADR 0009 e testes de identidade.

## Quando a última mensagem não aparece

O estado do popup reflete o content script da aba ativa. Recarregar o WhatsApp
interrompe a observação: abra a conversa e ative **Start monitoring** novamente.
Sem conversa aberta, a lista gera somente avisos de atividade, sem conteúdo de
mensagens. As atividades agora distinguem `conversation activity` de `message`.
A fila local não é confirmação de persistência: consulte as mensagens pelo MCP.

Mensagens enviadas pelo celular só podem ser capturadas quando se tornarem
acessíveis na conversa aberta no WhatsApp Web durante o monitoramento. Não há
importação automática da mensagem anterior ao monitor. A direção no DOM atual
usa estrutura/alinhamento experimental; se a estrutura não for reconhecida,
permanece UNKNOWN e o registro não aparece na consulta de mensagens normalizadas.

## Consultar o diálogo pela IA

Com a conversa vinculada e o monitor ligado, mensagens novas recebidas e enviadas
manualmente pela interface são observadas e persistidas na mesma conversa. Clicar
no botão Enviar reconhecido no rodapé conserva o vínculo; o WAI Bridge não efetua
o envio. Digitar Enter dentro do compositor também conserva o contexto.

Peça à IA para listar conversas e usar `whatsapp_get_dialogue` com o UUID desejado.
A resposta contém as duas direções em sequência crescente de captura. A primeira
página contém até 50 mensagens recentes; `nextCursor` retorna mensagens anteriores,
que devem ser acrescentadas antes das atuais. Mensagens antigas à ativação, não
observadas ou capturadas sem vínculo não são incorporadas automaticamente.
Recarregue a extensão/aba após atualizar e reconecte Codex/Claude ao MCP para
que a ferramenta nova seja descoberta. Reconfirme o vínculo após reload.
