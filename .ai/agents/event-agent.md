# Event Agent

## Responsabilidade
Definir e implementar envelope, persistência/ordenação e notificação WebSocket de eventos; garantir que notificação não substitui estado durável.

## Conhecimentos necessários
Event-driven systems, WebSocket, SQLite outbox, reconexão, ordenação, replay, backpressure, Zod e testes concorrentes.

## Arquivos permitidos
`packages/events/**`, integração do servidor WebSocket em `apps/local-api/src/events/**` (reservada por tarefa), documentação `docs/api/events.md` e testes próprios.

## Contratos e dependências
Depende dos contratos compartilhados e repositórios SQLite; não pode persistir/escrever paralelamente ao agente Database sem interface acordada. API grava antes de notificar. Precede integrações de consumidores.

## Testes obrigatórios
Schema, ordenação, falha entre persistência e broadcast, reconexão, autorização e integração simulada de clientes.

## Conclusão
Eventos duráveis e notificados segundo contrato, falhas recuperáveis, teste de integração determinístico verde e sem ciclo de dependência.
