CREATE TABLE wa_dialogue_sync_requests (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  status TEXT NOT NULL CHECK(status IN ('REQUESTED','CLAIMED','SUCCEEDED','FAILED','EXPIRED')),
  extension_instance_id TEXT,
  account_id TEXT,
  lease_token TEXT,
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX wa_dialogue_sync_pending_idx ON wa_dialogue_sync_requests(status,created_at);
