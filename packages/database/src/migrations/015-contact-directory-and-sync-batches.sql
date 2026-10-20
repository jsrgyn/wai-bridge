ALTER TABLE wa_contacts ADD COLUMN nickname TEXT;
ALTER TABLE wa_contacts ADD COLUMN full_name TEXT;
CREATE INDEX wa_contacts_registration_idx ON wa_contacts(created_at,id);
CREATE TABLE wa_dialogue_sync_batches (
 id TEXT PRIMARY KEY,
 idempotency_key TEXT NOT NULL UNIQUE,
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 account_id TEXT,
 run_token TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('RUNNING','PAUSED','COMPLETED','COMPLETED_WITH_ERRORS','CANCELLED','EXPIRED')),
 reason TEXT,
 paused_position INTEGER CHECK(paused_position IS NULL OR (paused_position>=0 AND paused_position<5000)),
 created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 completed_at TEXT
);
CREATE TABLE wa_dialogue_sync_batch_items (
 batch_id TEXT NOT NULL REFERENCES wa_dialogue_sync_batches(id),
 position INTEGER NOT NULL CHECK(position>=0 AND position<5000),
 conversation_id TEXT NOT NULL REFERENCES wa_conversations(id),
 query TEXT,
 status TEXT NOT NULL CHECK(status IN ('WAITING','ACTIVE','SUCCEEDED','FAILED','SKIPPED','CANCELLED')),
 sync_request_id TEXT REFERENCES wa_dialogue_sync_requests(id),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
 code TEXT,
 PRIMARY KEY(batch_id,position),
 UNIQUE(batch_id,conversation_id)
);
CREATE UNIQUE INDEX wa_sync_batch_one_active_item_idx ON wa_dialogue_sync_batch_items(batch_id) WHERE status='ACTIVE';
CREATE UNIQUE INDEX wa_sync_batch_one_running_idx ON wa_dialogue_sync_batches(status) WHERE status='RUNNING';
CREATE INDEX wa_sync_batch_child_idx ON wa_dialogue_sync_batch_items(sync_request_id);
