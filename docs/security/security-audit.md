# Auditoria de segurança

**Escopo:** inspeção estática do workspace, controles em fronteiras e testes existentes. Não é pentest nem avaliação formal. Nenhum endpoint foi exposto à rede; nenhum LaunchAgent foi iniciado.

## Controles observados

- API faz bind em `127.0.0.1`, exige Bearer token de pelo menos 32 caracteres e compara com `timingSafeEqual`; respostas não expõem stack trace.
- Fastify redige `authorization`, cookie, URL e body nos logs. Erros internos logam tipo/código, sem payload de mensagem.
- Token/extension ID ficam fora do source; `host-config.json` é gravado 0600 e diretórios privados 0700. O instalador não exige root.
- Native Messaging usa framing com versão/ID, valida schemas e origem Chrome allowlisted. Conteúdo de mensagens não altera políticas.
- MCP não acessa SQL/filesystem; ferramentas de escrita têm opt-in local e exigem autorização/idempotência no pedido.
- Media package gera chaves internas, limita bytes, usa assinatura MIME, hash, temporário exclusivo, `O_NOFOLLOW`, permite external root apenas com marcador e não executa arquivo recebido.
- FFmpeg usa `execFile` com argumentos, sem shell, timeout e diretório temporário privado. Provider cloud exige HTTPS e `allowExternalMedia`.
- Outbox persiste antes de invocar executor; idempotência, leases, destinatário único, delay cancelável e `UNKNOWN` terminal. Runtime usa executor simulado e nega AUTO.
- Mensagens/media são explicitamente tratadas como dados não confiáveis; nenhuma execução de comando deriva de conteúdo recebido.

## Findings

### SEC-01 — Autorização local coarse-grained (alto)

A API compartilha um token bearer de acesso total; não existem scopes por cliente/operação, rate limit ou modelo de identidade de processo. MCP pode expor escrita quando `WAI_MCP_ALLOW_WRITES=true`. Restrição loopback reduz exposição remota, mas não autentica outros processos locais que obtiveram o token. **Mitigação necessária antes de produção:** principal/scopes por integração, gestão de segredo no Keychain, limites de requisição e threat review de localhost/CSRF/rebinding.

### SEC-02 — Envio/captura pela interface real não validado (alto)

Os DOM adapters são experimentais e os comandos da extensão usam só fixture `data-wai-*`; Native Messaging não transporta comandos outbox. Não existe adapter de envio real. **Estado seguro observado:** não declarar operacional nem habilitar envio; nenhum envio real foi feito.

### SEC-03 — Dados locais sem criptografia em repouso (moderado)

Banco, mídia e backups dependem de permissões POSIX/criptografia do volume do macOS. Config do host contém token em JSON 0600. Keychain, criptografia de aplicação e gestão de chaves não estão implementados.

### SEC-04 — Proteção de logs/retention operacional incompleta (moderado)

API redige dados sensíveis; LaunchAgent grava stdout/stderr em arquivos locais sem rotação/retenção configurada. `wa_audit_log`, eventos, mensagens e backups carecem de política operacional unificada de retenção.

### SEC-05 — Prompt injection adversarial não tem avaliação ponta a ponta (moderado)

Providers incluem política para tratar conteúdo como não confiável e nenhum resultado de IA modifica permissões/execução. Entretanto, não há eval adversarial formal de prompts/modelos ou revisão de saída antes de ação humana.

### SEC-06 — Backup de DB e blobs de mídia não coordenados (moderado)

Rotina incluída faz backup consistente de SQLite. Blob store não está integrado ao API e não faz parte desse snapshot; se cache de mídia for ativado, deve ser copiado/restaurado em procedimento separado com retenção coordenada.

## Verificações executadas

- `pnpm audit`: zero advisories conhecidos no snapshot consultado.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, integração, unit/e2e da extensão: resultados em [`test-results.md`](../testing/test-results.md).
- SQLite path traversal/symlink, extensão inválida, API auth/schema, Native Messaging origin/framing e outbox ambiguity cobertos por testes sintéticos.

## Fora do escopo / não alegado

Não houve pentest, revisão de cada versão transitiva, verificação de assinatura/notarização, inspeção de sessão WhatsApp, análise da UI real, testes de invasão de prompt contra modelo real nem validação de configuração corporativa/macOS MDM.
