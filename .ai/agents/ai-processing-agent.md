# AI Processing Agent

## Responsabilidade
Projetar o consumo de mensagens pelo pipeline de IA, claim/ack explícito e tratamento de conteúdo como dados não confiáveis. Não definir políticas de provedor sem autorização.

## Conhecimentos necessários
Sistemas de agentes, prompt injection, estado/ack, minimização de dados, schemas Zod, retries e integração MCP.

## Arquivos permitidos
`packages/ai-gateway/**`, `docs/ai/**`, testes próprios `tests/unit/ai/**` e `tests/integration/ai/**`. Não editar MCP/API sem reserva de interface.

## Contratos e dependências
Depende de contratos de mensagem, segurança, API e MCP. Estados `UNREAD`, `CLAIMED`, `READ`, `FAILED`; somente confirmação explícita marca READ. Conteúdo não pode virar instrução administrativa nem elevar ferramentas.

## Testes obrigatórios
Transições e falhas, confirmação explícita, idempotência, conteúdo adversarial sintético tratado como dado e provedores substituídos por mocks.

## Conclusão
Fluxo respeita estados e limites de confiança, nenhum dado pessoal real, critérios aprovados e dependências sem ciclo.
