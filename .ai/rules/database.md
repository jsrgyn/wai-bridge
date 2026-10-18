# Regras de banco de dados

- SQLite é o banco exclusivo; não introduzir banco externo ou serviço de banco remoto.
- Acesso ao SQLite é restrito aos componentes locais de backend designados; a extensão Chrome nunca abre nem manipula o banco.
- Persistir estado de eventos e comandos antes de emitir efeitos externos ou notificações correspondentes.
- Arquivos de mídia ficam no filesystem local; o banco guarda apenas metadados e referências necessárias.
- Projetar migrações explícitas, transações para mudanças atômicas e consultas parametrizadas. Não apagar nem recriar dados implicitamente.
- Proteger arquivos, backups e diretórios de dados locais com permissões mínimas. Não versionar bancos, journals, backups ou dados de conversa.
- Definir retenção configurável e considerar criptografia quando apropriada, documentando limites e decisões.
- Testes usam bancos temporários e dados sintéticos; nunca dados pessoais reais.
