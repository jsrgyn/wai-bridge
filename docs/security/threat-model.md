# Modelo de ameaças inicial

## Escopo e ativos

Ativos: banco SQLite e journals, mídias locais, configuração/credenciais, conteúdo de mensagens, destinatários, histórico de comandos, logs, permissões de ferramentas MCP e interface de envio. Limites principais: WhatsApp Web/DOM → extensão → agente macOS → API local → banco/filesystem; consumidores MCP e conexões WebSocket são outros limites de confiança.

## Adversários e ameaças

- Conteúdo malicioso em mensagens, nomes ou mídia tentando prompt injection ou induzir ferramentas/ações.
- Página, extensão ou dependência comprometida tentando ampliar acesso ou exfiltrar dados.
- Processo local não autorizado tentando chamar a API, ler banco/mídia ou injetar comandos.
- Erro de destinatário, repetição, corrida ou resposta ambígua que cause envio incorreto ou duplicado.
- Logs, backups, fixtures ou arquivos locais expondo conteúdo pessoal e credenciais.
- Commits, metadados do autor, histórico Git, CI ou artefatos públicos expondo dados pessoais, tokens ou estado operacional.
- Captura incompleta que seja interpretada como histórico integral ou mensagem disponível quando não está.

## Controles obrigatórios

- Tratar conteúdo capturado apenas como dados não confiáveis; não permitir que altere instruções, política de ferramentas ou permissões.
- Limitar API a localhost e aplicar autenticação/controle de origem e autorização por operação adequados ao modelo local.
- Validar todos os contratos com Zod; validar e confirmar destinatários e autorização antes de ações de envio.
- Persistir intenção/estado antes de efeitos externos, auditar operações, permitir cancelamento no modo AUTO e não repetir resultado desconhecido.
- Restringir acesso a SQLite e filesystem ao backend local; extensão não acessa banco.
- Usar menor privilégio, segredos fora do código, logs mínimos, retenção configurável e proteção de arquivos locais; avaliar criptografia e gestão de chaves.
- Não acessar credenciais de sessão, interceptar protocolo interno, contornar controles ou implementar antidetecção.
- Utilizar dados sintéticos e mocks em testes; nunca enviar mensagem real automaticamente.
- Tratar o repositório, todas as branches e artefatos publicados como públicos; aplicar `.gitignore`, hook pre-commit e varredura de segredo; revisar manualmente dados pessoais que scanners não detectam.

## Riscos residuais e trabalho futuro

Este modelo é inicial, não avaliação formal. Antes de disponibilizar envio ou ferramentas MCP, detalhar autenticação local, autorização, origem/conexão, proteção contra CSRF/rebinding quando aplicável, limites de taxa, semântica de idempotência, consentimento, armazenamento de chaves, backup, retenção e resposta a incidentes. Não inferir que localhost sozinho autentica um cliente.

## Repositório público e resposta à exposição

Histórico Git e metadados de autoria publicados não são removidos ao editar um arquivo ou criar commit posterior. Se um segredo aparecer, revogue-o primeiro; remova o conteúdo atual e coordene eventual reescrita do histórico com todas as pessoas que usam o remoto. Considere clones, caches, releases e artefatos de CI como cópias independentes. O hook local bloqueia artefatos privados conhecidos, exige identidade local genérica e chama Gitleaks nos arquivos staged; não detecta toda informação pessoal e pode não estar habilitado em clones novos até configurar `core.hooksPath`.

## Controles de mídia locais (Prompt 11)

`packages/media` recebe bytes de uma fonte local autorizada, limita tamanho, identifica o MIME por assinatura, bloqueia assinaturas executáveis conhecidas e não interpreta arquivos como código. Chaves relativas são geradas a partir de tipo/data/SHA-256 e validadas antes de resolver caminhos; gravação usa arquivo temporário exclusivo, permissões privadas e criação sem sobrescrever. Leitura usa `O_NOFOLLOW`, tamanho e SHA-256; caminhos simbólicos suspeitos são rejeitados. Uma raiz externa exige marcador criado durante provisionamento e não é recriada automaticamente após desconexão. O limite da API continua pendente: o pacote não publica rota de bytes e a API ainda precisa decidir autorização por recurso antes de expor ingestão ou download. `ffprobe` é opcional e opera com timeout; manutenção de parser, criptografia em repouso e política operacional de backup/reconciliação permanecem itens de revisão.

## Canal experimental de envio pela extensão (ADR 0010)

Envio real passa por três declarações: autorização literal do pedido MCP, opt-in
específico no inicializador MCP e permissão no popup. A referência PARTIAL exige
contexto atual confirmado por conta/telefone ou UUID local de grupo; nomes não
resolvem destinatários. O token da API não vai à extensão. Progresso é vinculado
à instância, contexto, aba ativa e lease/token; token não aparece no status público
ou auditoria. API continua com principal Bearer full-access, sem scopes distintos.

SQLite confirma SENDING antes do clique. Perda desse ACK impede efeito, e incerteza
pós-SENDING nunca é reenfileirada automaticamente. Idempotência de criação/ACK,
lease da interface e kind separado evitam retries do dispatcher legado. Mudança
visível de contexto ou rascunho impede envio. Recuperação fecha leases vencidas;
comandos pré-execução expirados falham. O MCP consulta resultado persistido e não
interpreta REQUESTED como enviado.

Limites: referência confirmada e DOM visível não dão prova criptográfica do
remetente/destinatário, e marcadores visuais podem mudar. Um erro de cadastro local
ou alteração da UI sem sinal observável permanece possível. SENT significa evidência
visível suficiente, não validação de protocolo oficial. Provas automatizadas são
sintéticas; operação real do novo executor não foi validada em conta de usuário.

## Busca de destinatário por telefone (ADR 0012)

A busca da UI não é prova de identidade. Com locateByPhone explícito, só um comando
persistido de contato direto com número cadastrado pode ser reivindicado por outro
contexto aberto da mesma conta local. Conta local é uma declaração do navegador,
não prova criptográfica da conta WhatsApp: namespaces incorretos não devem ser
reutilizados. A extensão compara o telefone no perfil visível, não o texto da busca.
Revalida antes do efeito e mantém o contexto resolvido separado da lease original.
Rascunhos, ambiguidade, troca de perfil/conta e interferência interrompem. Não há
protocolos privados, novas permissões, leitura de sessão ou envio real em testes.

### Resolução por nome e prova do destinatário (ADR 0014)

Nome recebido pelo MCP é dado de busca, não instrução. Resolução ocorre na API e
na conta local autorizada; exige telefone único. O nome não autentica o perfil:
extensão precisa comparar telefone completo visível. Número informado não cria
contato verificado antecipadamente. Progresso autenticado pela lease apresenta
identidade/label; a API confere conta e telefone e persiste antes de SENDING.
Replay mantém intenção original mesmo após mudanças de cadastro. Ocultar a aba
não permite claim/efeito de envio; espera supervisionada pode manter o rascunho.
Campos de edição visíveis não são descartados para fechar o perfil. Nenhum aumento
de permissões, leitura de credenciais ou uso de protocolos internos foi adicionado.

### Entrega responsiva (ADR 0015)

Preflight ready=false não adquire lease. Ativação de aba existente exige opt-in,
pedido pendente autorizado e candidato único; identidade/visibilidade são relidas
antes de claim. Não cria abas, concede permissões, envia ocultamente ou contorna
controle do usuário. Supervisão activeCommand valida o mesmo owner/token/contexto;
cancel local só aceita mensagem da própria extensão para o comando ativo. ACK curto
não significa SENT. ACK perdido preserva claim para recuperação e nunca redelivery.
Build divergente impede uso de content script antigo. Diagnóstico expõe códigos e
contagens, não nomes/telefones/textos/tokens. Native capture concurrency é limitada
para não bloquear o controle de envio; frames continuam atômicos e validados.

## Logs operacionais (ADR0016)

Contrato estrito sem conteúdo privado/campos livres, códigos enumerados e autenticação local existente. Native host valida sessão e componentes de logs originados da extensão. Filas/batches e retenção limitam crescimento; diagnóstico não é evidência administrativa confiável nem autorização para efeitos. Conteúdo WhatsApp nunca é interpretado como instrução. Logs não devem ser publicados com a configuração/token local.

## Revisões e cobertura de captura (ADR0017)

Referências são UUIDs efêmeros de objetos visuais, não hashes de nome/texto ou IDs obtidos de protocolos privados. API valida fronteiras e escopo da revisão, preserva observações e evita sobrescrita por versão antiga. Mensagens externas continuam dados não confiáveis. Metadados de mídia expõem apenas IDs/tipos/estados; não transmitem bytes ou caminhos. Complete=false e atividades sem conteúdo evitam apresentar prévias como diálogo integral. ACK repetido é somente transporte idempotente de captura, nunca autorização para reenviar mensagem.

Reconciliação explícita (ADR0018/schema13): job persiste antes de navegação; Bearer local/Native Messaging com origem e instância autorizadas. Payload e resultado validados por Zod, query limitada, até50 observações, HTTP4MiB somente no endpoint batch, fila20/TTL30s, lease/conta/contexto, bloqueio de ambiguidade/rascunho e exclusão mútua com send. Abrir uma conversa pode marcar leitura no WhatsApp; não confirma leitura da IA. HTML/credenciais/protocolo privado não são coletados; não há rolagem/importação indiscriminada. Observações são dados não confiáveis. Sync SUCCEEDED representa commit de snapshot visível parcial, não cobertura integral. Logs por UUID omitem conteúdo, nomes, telefones e tokens; pedidos/resultados permanecem no banco privado conforme política existente, sem purga automática nesta entrega.

### Pendências e associação de referências (ADR0019)

Atividade externa nunca autoriza navegação: a lista e seus títulos são dados não confiáveis. Somente pedido deliberado da IA abre a conversa solicitada; mesmas barreiras de FR-18. ACK exige confirmação literal e watermark atual; mensagens concorrentes não podem ser apagadas por confirmação antiga. Referência vinculada deve corresponder ao resultado por identidade, telefone comprovado ou associação explícita compatível, nunca somente nome. Relações não fundem históricos nem autorizam envio. Rotas autenticadas, auditoria de ACK/associação sem corpos/nomes/telefones; estados de WhatsApp/IA/conferência independentes. Metadados de não lidas no início não importam prévias/histórico.

### Diretório e leitura sequencial (ADR0020)

Consulta de contatos é estritamente SQLite; não abrir UI, inferir esposa/parentesco, completar números ou expor credenciais. Texto de busca é literal parametrizado, inclusive `%`/`_`; contrato valida modo, data, fuso e paginação. Campos pessoais somente no retorno autorizado, não nos logs. Apelido/nome completo desconhecidos permanecem null.

Batch exige autorização literal e snapshot persistido de referências de uma conta antes da navegação. Limite5000, execução serial, corpo/frames limitados e exclusão com envio existentes. Lista/status não agenda navegação. Interação/rascunho/conta/contexto/incerteza pausam; runToken só muda por retomada explícita. Cancelamento entre API/background/content exige lease/instância/conta exatas e requestId ativo; remetente de content message validado. Resposta tardia cancelada não publica conteúdo. Resultados são dados não confiáveis; nenhum conteúdo recebido autoriza criar/retomar lote ou marcar leitura. Logs/auditoria de lote usam IDs/contagens, nunca nomes, telefone ou corpos. Não testar em conta real nem enviar mensagens em automação.
