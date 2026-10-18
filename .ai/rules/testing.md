# Regras de teste

- Escreva testes determinísticos para regras de negócio novas ou alteradas e para caminhos críticos.
- Separe unitários, integração e e2e. Use mocks e fixtures sintéticas; não inclua dados pessoais.
- Testes de banco usam arquivo temporário ou banco isolado; não tocam dados de usuário.
- Não efetue envios reais, não conecte a contas reais e não dependa de sessão WhatsApp em automação.
- Cubra estados, falhas, cancelamento, idempotência e resultado desconhecido quando relevantes ao escopo.
- Registre comandos executados e resultados observados. Não alegue execução por inferência.
