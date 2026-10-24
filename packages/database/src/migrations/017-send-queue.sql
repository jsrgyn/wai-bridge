CREATE TABLE wa_send_settings (
 singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1), timing_json TEXT NOT NULL CHECK(json_valid(timing_json)), updated_at TEXT NOT NULL
);
CREATE TABLE wa_send_queue_state (
 singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1), paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1)), pause_reason TEXT, paused_at TEXT
);
ALTER TABLE wa_outbox ADD COLUMN priority INTEGER NOT NULL DEFAULT 0 CHECK(priority IN (0,1));
ALTER TABLE wa_outbox ADD COLUMN target_key TEXT;
ALTER TABLE wa_outbox ADD COLUMN timing_json TEXT;
INSERT INTO wa_outbox_history(id,command_id,from_status,to_status,actor,at,reason_code,correlation_id)
 SELECT lower(hex(randomblob(16))),id,'REQUESTED','QUEUED','migration-017',strftime('%Y-%m-%dT%H:%M:%fZ','now'),'MIGRATED_TO_QUEUED',id
 FROM wa_outbox WHERE kind='extension-send' AND status='REQUESTED';
UPDATE wa_outbox SET status='QUEUED' WHERE kind='extension-send' AND status='REQUESTED';
CREATE INDEX wa_outbox_send_queue_idx ON wa_outbox(kind,status,priority DESC,created_at,id);
