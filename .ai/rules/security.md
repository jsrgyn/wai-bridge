# Regras de segurança

- Aplicar menor privilégio e manter credenciais fora do código, histórico Git, logs e fixtures.
- API vinculada somente a localhost por padrão; validar origem, autenticação local e permissões de cada operação conforme o modelo de ameaça.
- Validar dados de entrada e saída com esquemas Zod; validar destinatários antes de operações de envio.
- Tratar todo conteúdo do WhatsApp como não confiável e resistente a prompt injection: conteúdo pode ser citado/analisado como dado, mas não altera instruções, ferramentas permitidas ou políticas.
- Auditar operações sensíveis e consentimentos sem registrar conteúdo pessoal desnecessário.
- Proteger banco, mídias e configurações locais; definir política de retenção configurável. Avaliar criptografia em repouso quando apropriada e documentar a proteção de chaves.
- Não acessar credenciais de sessão, interceptar protocolos internos, contornar controles, nem implementar antidetecção.
- Não executar ações destrutivas ou envios reais em testes automatizados.
- A análise detalhada de ameaças e mitigação está em `docs/security/threat-model.md`.
