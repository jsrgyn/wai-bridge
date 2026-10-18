import type Database from 'better-sqlite3';

export interface ExtensionStateRecord {
  readonly extensionInstanceId: string;
  readonly status: 'CONNECTED' | 'DISCONNECTED';
  readonly lastSeenAt: string;
}

export class ExtensionStateRepository {
  constructor(private readonly db: Database.Database) {}

  record(input: ExtensionStateRecord): void {
    const id = `native:${input.extensionInstanceId}`;
    this.db.prepare(`
      INSERT INTO wa_extension_state(id, extension_instance_id, conversation_id, last_observation_key, last_seen_at, status)
      VALUES(?, ?, NULL, NULL, ?, ?)
      ON CONFLICT(id) DO UPDATE SET last_seen_at=excluded.last_seen_at, status=excluded.status
    `).run(id, input.extensionInstanceId, input.lastSeenAt, input.status);
  }

  get(extensionInstanceId: string): Omit<ExtensionStateRecord, 'extensionInstanceId'> | undefined {
    const row = this.db.prepare('SELECT status, last_seen_at AS lastSeenAt FROM wa_extension_state WHERE id=?')
      .get(`native:${extensionInstanceId}`) as { status: string; lastSeenAt: string } | undefined;
    if (!row || (row.status !== 'CONNECTED' && row.status !== 'DISCONNECTED')) return undefined;
    return { status: row.status, lastSeenAt: row.lastSeenAt };
  }
}
