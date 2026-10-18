CREATE TABLE wa_ai_consumer_message_state (
  message_id TEXT NOT NULL REFERENCES wa_messages(id) ON DELETE CASCADE,
  consumer_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('UNREAD','CLAIMED','READ','FAILED')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  claim_token TEXT,
  lease_until TEXT,
  updated_at TEXT NOT NULL,
  last_error_code TEXT,
  PRIMARY KEY(message_id, consumer_id),
  CHECK ((state = 'CLAIMED' AND claim_token IS NOT NULL AND lease_until IS NOT NULL) OR state <> 'CLAIMED')
);
CREATE INDEX wa_ai_consumer_state_due_idx ON wa_ai_consumer_message_state(consumer_id,state,lease_until,updated_at,message_id);
