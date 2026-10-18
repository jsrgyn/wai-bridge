# ADR 0002: Contratos iniciais e modelo de dados

- Data: 2026-10-17
- Status: Proposed (WB-001 handoff pending independent architecture/security review)

## Contexto
O planejamento WB-001/WB-002 deixou ownership de SQLite, eventos, IDs, UTC e novidade de captura sem definição. Prompt 04 solicita contratos antes da implementação.

## Decisão proposta
API local é o único processo que abre SQLite; agente macOS somente encaminha. IDs internos UUIDv7 e IDs externos opcionais/escopados. Timestamps RFC 3339 UTC; sequência local/cursor ordena. Eventos persistidos antes de broadcast, com semântica at-least-once e deduplicação por event ID. Captura “nova” é observada após início do monitor, sem backfill visual/histórico. API OpenAPI draft usa GET read-only, POST ACK explícito para READ, comandos idempotentes e UNKNOWN sem retry automático.

## Alternativas
- Agente macOS como dono físico do SQLite: aumenta acoplamento e coloca persistência fora da autoridade de negócio da API.
- Entrega exatamente uma vez: não é garantível entre SQLite, processo e WebSocket; adota-se at-least-once e dedupe.
- Nome visível como identidade: rejeitado por não ser estável nem único.

## Consequências
A decisão resolve parcialmente o bloqueio WB-001 e orienta contratos, mas schema SQL e rotas permanecem draft. Antes de implementação, Security/Architect devem revisar autenticação local, mecanismo de credencial, políticas de retry/leases, retenção, criptografia, cursor e critério de resultado verificável. Este ADR requer aceitação explícita no gate P0.

## Handoff WB-001 (2026-10-17)

- Proposta de ownership registrada: somente a Local API abre conexão SQLite operacional; o macOS Agent encaminha mensagens e não acessa o banco.
- Coerência documental conferida em `docs/architecture/system-architecture.md`, `docs/architecture/component-diagram.md`, `docs/database/schema-design.md`, `docs/architecture/native-messaging.md` e ADR 0003.
- Bloqueio: não há aprovação independente de Architecture/Security registrada. O ADR permanece `Proposed` e WB-001 não pode ser marcado `DONE` até a revisão e aceitação explícitas.
- Escopo da revisão futura: confirmar ownership do processo sem implicar aprovação dos demais contratos propostos neste ADR, que seguem draft.
