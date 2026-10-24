import type Database from 'better-sqlite3';
import {
  DEFAULT_SEND_TIMING,
  SendTimingOverrideSchema,
  SendTimingSchema,
  resolveSendTiming,
  type SendTiming,
  type SendTimingOverride,
} from '@wai-bridge/shared';

export class SendSettingsRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}
  get(): SendTiming {
    const row = this.db.prepare('SELECT timing_json FROM wa_send_settings WHERE singleton_id=1').get() as
      | { timing_json: string }
      | undefined;
    return row ? SendTimingSchema.parse(JSON.parse(row.timing_json)) : DEFAULT_SEND_TIMING;
  }
  update(input: SendTimingOverride): SendTiming {
    const override = SendTimingOverrideSchema.parse(input);
    const tx = this.db.transaction(() => {
      const next = SendTimingSchema.parse(resolveSendTiming(this.get(), override));
      this.db
        .prepare(
          'INSERT INTO wa_send_settings(singleton_id,timing_json,updated_at) VALUES(1,?,?) ON CONFLICT(singleton_id) DO UPDATE SET timing_json=excluded.timing_json,updated_at=excluded.updated_at',
        )
        .run(JSON.stringify(next), this.now());
      return next;
    });
    return tx.immediate();
  }
}
