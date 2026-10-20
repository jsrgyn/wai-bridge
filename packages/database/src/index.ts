export { openDatabase } from './database.js';
export type { DatabaseOptions } from './database.js';
export { applyMigrations, migrations } from './migrations.js';
export { createConsistentBackup } from './backup.js';
export { MessageRepository } from './repositories/messages.js';
export { CommandRepository } from './repositories/commands.js';
export { OutboxRepository, OutboxStatusSchema } from './repositories/outbox.js';
export type { OutboxCommand, OutboxStatus } from './repositories/outbox.js';
export { AIMessageStateRepository } from './repositories/reading-state.js';
export { ExtensionStateRepository } from './repositories/extension-state.js';
export { CaptureObservationRepository } from './repositories/capture-observations.js';
export { CaptureNormalizationRepository } from './repositories/capture-normalization.js';
export { MediaRepository } from './repositories/media.js';
export type { MediaRecord, MediaStatus, MediaKind } from './repositories/media.js';
export * from './schemas.js';
export { ApiReadRepository } from './repositories/api-read.js';
export { ExtensionSendRepository } from './repositories/extension-send.js';

export {FlowLogRepository} from './repositories/flow-logs.js';
export { DialogueSyncRepository } from './repositories/dialogue-sync.js';
export { ConversationReviewRepository } from './repositories/conversation-review.js';
export { ContactDirectoryRepository } from './repositories/contact-directory.js';
export { DialogueSyncBatchRepository } from './repositories/dialogue-sync-batch.js';

export {OperationsRepository} from './repositories/operations.js';

export {MaintenanceService,verifyRestoredBackup} from './maintenance.js';
