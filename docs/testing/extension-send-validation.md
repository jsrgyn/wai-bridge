# Validação do envio pela extensão — 2026-10-18

ADR 0010 registra o novo canal. Não houve envio real nem execução de testes em
conta WhatsApp. Código de produção usa apenas DOM visível e Native Messaging;
automação Playwright existe somente nos testes sintéticos.

## Evidências executadas

- Repositório SQLite: persistência/idempotência, referência desconhecida rejeitada,
  lease/contexto incorretos rejeitados, countdown obrigatório, SENDING antes de SENT,
  evidência obrigatória, cancelamento, serialização da interface e expiração sem
  reenfileirar comandos. Auditoria não inclui token de lease. Dispatcher legado
  não reivindica nem recupera extension-send.
- Bridge do service worker: gate local off impede polling, somente aba WhatsApp
  ativa com vínculo recebe comando; progresso de outra aba é rejeitado e somente
  um comando é executado por vez.
- MCP: opt-in independente de writes legados, autorização literal exigida,
  idempotency key transmitida e retorno REQUESTED sem alegar envio.
- Native Host→API→SQLite: handshake/origem/instância, claim, progresso ACK e resultado
  persistido, sem entregar o comando novamente.
- Sete Playwright: AUTO aguarda cinco segundos e clica uma vez; SUPERVISED aguarda
  clique manual; perda do ACK SENDING impede clique; cancelamento, gate off,
  rascunho existente, contexto alterado e revogação impedem envio; bolha pendente
  termina UNKNOWN sem segundo clique. Evidência usa texto exato com emoji.

Build, lint e typecheck passaram. Testes raiz: 123/15 arquivos; integração: 3/2 arquivos;
extensão: 7 unitários/4 arquivos e 33 Playwright. SDK pelo launcher instalado descobriu
17 ferramentas e status ok/database connected/schema 8. API local atualizada, banco
íntegro após backup. A extensão do Chrome ainda requer recarga e opt-in pelo usuário.
Gate no popup e confirmação da conversa são ações do usuário, não ativadas por teste.
