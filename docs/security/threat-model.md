# Modelo de ameaças inicial

## Escopo e ativos

Ativos: banco SQLite e journals, mídias locais, configuração/credenciais, conteúdo de mensagens, destinatários, histórico de comandos, logs, permissões de ferramentas MCP e interface de envio. Limites principais: WhatsApp Web/DOM → extensão → agente macOS → API local → banco/filesystem; consumidores MCP e conexões WebSocket são outros limites de confiança.

## Adversários e ameaças

- Conteúdo malicioso em mensagens, nomes ou mídia tentando prompt injection ou induzir ferramentas/ações.
- Página, extensão ou dependência comprometida tentando ampliar acesso ou exfiltrar dados.
- Processo local não autorizado tentando chamar a API, ler banco/mídia ou injetar comandos.
- Erro de destinatário, repetição, corrida ou resposta ambígua que cause envio incorreto ou duplicado.
- Logs, backups, fixtures ou arquivos locais expondo conteúdo pessoal e credenciais.
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

## Riscos residuais e trabalho futuro

Este modelo é inicial, não avaliação formal. Antes de disponibilizar envio ou ferramentas MCP, detalhar autenticação local, autorização, origem/conexão, proteção contra CSRF/rebinding quando aplicável, limites de taxa, semântica de idempotência, consentimento, armazenamento de chaves, backup, retenção e resposta a incidentes. Não inferir que localhost sozinho autentica um cliente.

## Controles de mídia locais (Prompt 11)

`packages/media` recebe bytes de uma fonte local autorizada, limita tamanho, identifica o MIME por assinatura, bloqueia assinaturas executáveis conhecidas e não interpreta arquivos como código. Chaves relativas são geradas a partir de tipo/data/SHA-256 e validadas antes de resolver caminhos; gravação usa arquivo temporário exclusivo, permissões privadas e criação sem sobrescrever. Leitura usa `O_NOFOLLOW`, tamanho e SHA-256; caminhos simbólicos suspeitos são rejeitados. Uma raiz externa exige marcador criado durante provisionamento e não é recriada automaticamente após desconexão. O limite da API continua pendente: o pacote não publica rota de bytes e a API ainda precisa decidir autorização por recurso antes de expor ingestão ou download. `ffprobe` é opcional e opera com timeout; manutenção de parser, criptografia em repouso e política operacional de backup/reconciliação permanecem itens de revisão.
