import { MaintenanceService } from '@wai-bridge/database';
import { dirname, join } from 'node:path';
import { resolve } from 'node:path';
import { openDatabase } from '@wai-bridge/database';
import { OutboxRepository } from '@wai-bridge/database';
import {
  DatabaseRecipientResolver,
  DenyAutoAuthorizationVerifier,
  OutboxDispatcher,
  OutboxService,
  SimulatedSendExecutor,
} from '@wai-bridge/outbox-engine';
import { buildApp } from './app.js';
const token = process.env.WAI_BRIDGE_API_TOKEN;
if (!token) throw new Error('WAI_BRIDGE_API_TOKEN must be configured outside source control');
const dataDir = resolve(process.env.WAI_BRIDGE_DATA_DIR ?? '.local-data');
const db = openDatabase(process.env.WAI_BRIDGE_DB_PATH ?? `${dataDir}/wai-bridge.sqlite`);
const outboxRepository = new OutboxRepository(db);
const outboxService = new OutboxService(outboxRepository);
const outboxDispatcher = new OutboxDispatcher(
  outboxRepository,
  outboxService,
  new DatabaseRecipientResolver(outboxRepository),
  new DenyAutoAuthorizationVerifier(),
  new SimulatedSendExecutor(),
);
const maintenance = new MaintenanceService(db, join(dirname(db.name), 'backups'));
const app = buildApp({ db, apiToken: token, outboxDispatcher, maintenance });
const shutdown = async () => {
  await app.close();
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
await app.listen({ host: '127.0.0.1', port: Number(process.env.WAI_BRIDGE_API_PORT ?? 47831) });

maintenance.start();
