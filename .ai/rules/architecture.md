# Regras de arquitetura

## Componentes e responsabilidades

- O SQLite é o único banco de dados. Não adicionar bancos externos, serviços de persistência remota nem dependência deles.
- A extensão Chrome interage com WhatsApp Web apenas por interfaces acessíveis na página e não acessa SQLite nem arquivos de banco diretamente.
- O agente macOS intermedeia a comunicação entre a extensão e os serviços locais. Ele não deve duplicar regras de negócio da API.
- A API REST local implementa a lógica de negócio e é a autoridade para validar e persistir comandos e transições.
- O servidor MCP expõe à IA ferramentas deliberadas por contratos documentados; não contorna API, autorização ou persistência.
- WebSocket notifica eventos em tempo real. Notificação não substitui o estado persistente nem confirma processamento.
- SQLite armazena estado persistente de eventos e comandos. O filesystem local armazena mídias, referenciadas por metadados persistidos.
- Todos os contratos entre módulos e fronteiras de entrada/saída são validados com Zod.

## Modularidade

- Mantenha módulos coesos, responsabilidades explícitas e dependências dirigidas para dentro: aplicações compõem packages; packages não dependem de apps.
- `shared` contém contratos e tipos realmente comuns, sem lógica de domínio duplicada.
- Não crie abstrações ou camadas sem necessidade demonstrável. Preserve testabilidade através de limites claros e dependências substituíveis.
- Decisões que alterem responsabilidades, protocolos ou direção de dependências devem ser registradas como ADR antes ou junto da mudança.

## Fluxo de referência

Chrome Extension → Mac Agent → Local REST API → packages de domínio/persistência; API → SQLite/filesystem. MCP consome capacidades autorizadas da API. API emite eventos persistidos e WebSocket os notifica. Este fluxo descreve limites arquiteturais, não implementações já existentes.
