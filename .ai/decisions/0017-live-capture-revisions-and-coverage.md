# ADR 0017 — Atualizações de captura e cobertura explícita

Data: 2026-10-19. Estado: aceito no escopo solicitado.

O observador anterior acompanhava inserções, mas ignorava mudanças de mensagens já capturadas e anexos tardios. Atividades da lista não recebiam identidade estável de objeto visual e podiam criar conversas desconectadas. Prévia não equivale a mensagem completa.

Mensagens observadas após ON recebem referência local efêmera UUID, revisão crescente e horário da primeira observação. Mudanças semânticas no mesmo objeto/marker renderizado geram observações imutáveis; a API mantém uma projeção atual da mensagem sem duplicar o diálogo. SQLite conserva observações anteriores. Duplicação de transporte é idempotente, revisões antigas não sobrescrevem novas, referências não são compartilhadas entre instâncias/conversas. Não deduplicar por texto/nome nem interpretar markers privados. Não importar o histórico inicial.

Atividades de linhas renderizadas usam a mesma referência local que a conversa aberta correspondente, sem unir homônimos. API e MCP expõem sinais de atividade, mensagens indisponíveis e cobertura parcial. Anexos são detectados pela UI como metadados; presença não implica download de bytes. Não capturar credenciais ou protocolos privados, rolar histórico ou navegar automaticamente entre conversas nesta entrega.

Limite: DOM virtualizado não expõe todas as mensagens da conta. FR-13 segue parcial. Não garantir ausência de lacunas, cobertura durante desconexão, histórico anterior ou conversas não renderizadas. Uma garantia integral exige fonte suportada de eventos e identidades estáveis, ainda não selecionada. Nenhuma nova dependência/serviço é introduzida; SQLite continua exclusivo da API.

Complemento em 2026-10-19: o baseline de mensagens já renderizadas ao ligar ON passa a ser um snapshot semântico transitório, sem captura inicial. Alterações posteriores desse estado também geram observações/revisões, independentemente da data antiga da mensagem. Não preservar exclusão permanente de um nó que mudou durante o monitoramento. Observar todos os atributos das raízes restritas permite reconhecer alterações de mídia/status sem manter uma allowlist incompleta de atributos; comparação semântica continua filtrando redraw/decorativos. Não registrar cada mutação arbitrária como mensagem nem salvar HTML bruto. Persistência segue o mesmo contrato de revisões e a mesma arquitetura, sem migration adicional.
