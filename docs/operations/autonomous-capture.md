# Captura automática da interface visível

Com o monitor ON, a extensão atribui uma referência local à conversa aberta sem
pedir cadastro de contato/grupo, leitura manual de perfil ou confirmação de vínculo.
ON é retomado após recarregar a página; OFF continua OFF. Atualizar a extensão
exige recarregá-la no Chrome e recarregar uma vez o WhatsApp Web.

Entradas e saídas novas renderizadas seguem o mesmo caminho: extensão → native
host → API → SQLite. Saídas sincronizadas do celular são tratadas como OUTBOUND
quando aparecem na interface com direção reconhecida. Não há importação inicial
do histórico nem acesso ao protocolo privado. Referências são registradas mesmo
com a opção de envio pelo MCP desligada. Essa opção continua controlando envios.

`whatsapp_list_conversations` localiza as conversas persistidas;
`whatsapp_get_dialogue` recebe `conversationId`, retorna as mensagens observadas
em sequência, direção, interlocutor e paginação para mensagens anteriores.
`accountWideCoverage=false` e `previousHistoryImported=false` explicitam os limites.
`identitySource=VISIBLE_UI`, `identityStatus=PARTIAL` e
`identityContinuity=CURRENT_UI_REFERENCE` distinguem a referência automática.
`confirmedAt` nessa modalidade indica a observação local, não confirmação humana.

A referência automática usa UUID de objeto visual e um namespace local do navegador.
Não usa nome, foto, índice da lista ou hash do nome como chave global. Nomes iguais
em linhas distintas ficam separados. Recarregar a página, reciclar linhas ou renomear
pode fragmentar a conversa em novas referências; não há união automática por nome.
A classificação contato/grupo fica UNKNOWN quando não há evidência explícita.
As referências manuais anteriores continuam disponíveis nas opções avançadas.

## Limite verificado

O painel fechado não renderiza o diálogo inteiro. A lista lateral pode sinalizar
atividade sem disponibilizar o conteúdo das mensagens. A extensão não navega por
contatos, não rola histórico e não transforma prévias em diálogos completos.
Portanto, esta implementação automatiza a captura da conversa aberta; não garante
todas as mensagens da conta, mensagens durante desconexão ou continuidade entre
sessões. A IA deve informar essa cobertura parcial ao responder.

Para garantir recebimento de todas as mensagens independentemente da conversa
aberta será necessária uma integração suportada de eventos, com identidade estável
e regras próprias de sincronização. Isso não pode ser prometido pelo DOM atual.

## Atividade em conversas fechadas

O observador da lista também acompanha mudanças das prévias e horários das linhas
renderizadas. Isso inclui sinais que podem ser produzidos por envios de outro
cliente sem aumentar a contagem de não lidas. A referência inicial é estabelecida
sem emitir/importar as prévias existentes; parar o monitor encerra a observação.
As comparações são limitadas e ficam apenas na memória, sem virar identidade.

Mudanças geram CONVERSATION_ACTIVITY/DETECTED, com direction=UNKNOWN,
content=null e contentAvailability=UNAVAILABLE. Essa atividade segue o caminho de
persistência existente e não é convertida em diálogo completo. A lista é
virtualizada: linhas não renderizadas e duas mensagens com a mesma prévia/horário
podem não produzir um sinal distinguível. Esse mecanismo não satisfaz FR-13 sozinho.

## Identificação exibida pelo WhatsApp

O cadastro persiste nome do contato e telefone internacional quando observados;
grupo persiste seu nome. O telefone pode ser complementado automaticamente ao
aparecer no perfil visível correspondente à conversa, sem confirmar vínculo manual
nem esperar uma nova mensagem. O perfil precisa estar aberto e visível; a extensão
não o abre sozinha. Até haver evidência inequívoca, telefone fica null. Não é
possível obter um número que o WhatsApp não expõe apenas a partir do nome salvo.
