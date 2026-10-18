ALTER TABLE wa_event_delivery ADD COLUMN lease_owner TEXT;
ALTER TABLE wa_event_delivery ADD COLUMN lease_until TEXT;
ALTER TABLE wa_event_delivery ADD COLUMN next_attempt_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';
ALTER TABLE wa_event_delivery ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 8 CHECK (max_attempts > 0);
ALTER TABLE wa_event_delivery ADD COLUMN last_error_code TEXT;
ALTER TABLE wa_event_delivery ADD COLUMN dead_lettered_at TEXT;
CREATE INDEX wa_event_delivery_due_idx ON wa_event_delivery(status, next_attempt_at, lease_until);
CREATE TABLE wa_event_delivery_attempt (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES wa_event_delivery(id),
  attempt INTEGER NOT NULL,
  worker_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('RUNNING','DELIVERED','RETRY','DEAD_LETTER')),
  error_code TEXT,
  UNIQUE (delivery_id, attempt)
);
CREATE INDEX wa_event_delivery_attempt_delivery_idx ON wa_event_delivery_attempt(delivery_id, attempt);
