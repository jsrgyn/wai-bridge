PRAGMA foreign_keys = ON;
CREATE TABLE wa_contacts (
  id TEXT PRIMARY KEY,
  connector TEXT NOT NULL,
  account_scope TEXT NOT NULL,
  external_id TEXT,
  display_name TEXT,
  identity_status TEXT NOT NULL CHECK (identity_status IN ('KNOWN','UNKNOWN','PARTIAL')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (connector, account_scope, external_id)
);
CREATE TABLE wa_conversations (
  id TEXT PRIMARY KEY,
  connector TEXT NOT NULL,
  account_scope TEXT NOT NULL,
  external_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('DIRECT','GROUP','UNKNOWN')),
  title TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (connector, account_scope, external_id)
);
CREATE TABLE wa_group_members (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES wa_conversations(id),
  contact_id TEXT REFERENCES wa_contacts(id),
  external_member_id TEXT,
  display_name TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  CHECK (contact_id IS NOT NULL OR external_member_id IS NOT NULL)
);
CREATE UNIQUE INDEX wa_group_members_identity_uq ON wa_group_members(conversation_id, contact_id) WHERE contact_id IS NOT NULL;
CREATE TABLE wa_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES wa_conversations(id),
  sender_contact_id TEXT REFERENCES wa_contacts(id),
  external_id TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('INBOUND','OUTBOUND')),
  capture_status TEXT NOT NULL CHECK (capture_status IN ('DETECTED','CAPTURED','PENDING','FAILED')),
  content TEXT,
  content_availability TEXT NOT NULL CHECK (content_availability IN ('AVAILABLE','PARTIAL','UNAVAILABLE')),
  observed_at TEXT NOT NULL,
  captured_at TEXT,
  sequence INTEGER NOT NULL,
  idempotency_scope TEXT,
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (conversation_id, sequence),
  UNIQUE (idempotency_scope, idempotency_key)
);
CREATE UNIQUE INDEX wa_messages_external_uq ON wa_messages(conversation_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX wa_messages_recent_idx ON wa_messages(sequence DESC, id);
CREATE INDEX wa_messages_conversation_recent_idx ON wa_messages(conversation_id, sequence DESC, id);
CREATE VIRTUAL TABLE wa_messages_fts USING fts5(message_id UNINDEXED, content, tokenize='unicode61');
CREATE TRIGGER wa_messages_fts_insert AFTER INSERT ON wa_messages WHEN new.content IS NOT NULL BEGIN
  INSERT INTO wa_messages_fts(message_id, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER wa_messages_fts_update AFTER UPDATE OF content ON wa_messages BEGIN
  DELETE FROM wa_messages_fts WHERE message_id = old.id;
  INSERT INTO wa_messages_fts(message_id, content) SELECT new.id, new.content WHERE new.content IS NOT NULL;
END;
CREATE TRIGGER wa_messages_fts_delete AFTER DELETE ON wa_messages BEGIN
  DELETE FROM wa_messages_fts WHERE message_id = old.id;
END;
CREATE TABLE wa_media (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES wa_messages(id),
  media_type TEXT,
  mime_type TEXT,
  size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),
  sha256 TEXT,
  storage_key TEXT,
  availability TEXT NOT NULL CHECK (availability IN ('AVAILABLE','PARTIAL','UNAVAILABLE')),
  created_at TEXT NOT NULL
);
CREATE INDEX wa_media_message_idx ON wa_media(message_id);
CREATE TABLE wa_media_analysis (
  id TEXT PRIMARY KEY,
  media_id TEXT NOT NULL REFERENCES wa_media(id),
  analysis_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','COMPLETED','FAILED')),
  result_ref TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE wa_ai_message_state (
  message_id TEXT PRIMARY KEY REFERENCES wa_messages(id),
  state TEXT NOT NULL CHECK (state IN ('UNREAD','CLAIMED','READ','FAILED')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  claimed_by TEXT,
  claim_token TEXT,
  updated_at TEXT NOT NULL,
  last_error_code TEXT
);
CREATE TABLE wa_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  sequence INTEGER NOT NULL UNIQUE,
  occurred_at TEXT NOT NULL,
  payload_version INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  idempotency_scope TEXT,
  idempotency_key TEXT,
  UNIQUE (idempotency_scope, idempotency_key)
);
CREATE TABLE wa_event_delivery (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES wa_events(id),
  consumer_id TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  status TEXT NOT NULL CHECK (status IN ('PENDING','DELIVERED','ACKED','FAILED')),
  cursor TEXT NOT NULL,
  delivered_at TEXT,
  acked_at TEXT,
  UNIQUE (event_id, consumer_id)
);
CREATE TABLE wa_outbox (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  idempotency_scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  next_attempt_at TEXT,
  result_ref TEXT,
  UNIQUE (idempotency_scope, idempotency_key)
);
CREATE INDEX wa_outbox_pending_idx ON wa_outbox(status, next_attempt_at);
CREATE TABLE wa_outbox_history (
  id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL REFERENCES wa_outbox(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor TEXT NOT NULL,
  at TEXT NOT NULL,
  reason_code TEXT,
  correlation_id TEXT NOT NULL
);
CREATE INDEX wa_outbox_history_command_idx ON wa_outbox_history(command_id, at);
CREATE TABLE wa_extension_state (
  id TEXT PRIMARY KEY,
  extension_instance_id TEXT NOT NULL,
  conversation_id TEXT REFERENCES wa_conversations(id),
  last_observation_key TEXT,
  last_seen_at TEXT NOT NULL,
  status TEXT NOT NULL
);
CREATE UNIQUE INDEX wa_extension_state_instance_conv_uq ON wa_extension_state(extension_instance_id, conversation_id) WHERE conversation_id IS NOT NULL;
CREATE TABLE wa_sync_state (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL UNIQUE,
  cursor TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE TABLE wa_audit_log (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  at TEXT NOT NULL,
  outcome TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL
);
CREATE INDEX wa_audit_resource_time_idx ON wa_audit_log(resource_type, resource_id, at DESC);
CREATE INDEX wa_events_aggregate_idx ON wa_events(aggregate_type, aggregate_id, sequence);
