ALTER TABLE wa_outbox ADD COLUMN lease_owner TEXT;
ALTER TABLE wa_outbox ADD COLUMN lease_until TEXT;
ALTER TABLE wa_outbox ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0);
ALTER TABLE wa_outbox ADD COLUMN execution_started_at TEXT;
ALTER TABLE wa_outbox ADD COLUMN result_code TEXT;
ALTER TABLE wa_outbox ADD COLUMN authorization_ref TEXT;
CREATE INDEX wa_outbox_dispatch_idx ON wa_outbox(status,next_attempt_at,lease_until,created_at,id);
CREATE TABLE wa_outbox_interface_lease (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  owner TEXT NOT NULL,
  command_id TEXT NOT NULL REFERENCES wa_outbox(id),
  lease_until TEXT NOT NULL
);
