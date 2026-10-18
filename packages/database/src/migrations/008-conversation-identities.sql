ALTER TABLE wa_capture_normalizations RENAME TO wa_capture_normalizations_v7;
CREATE TABLE wa_capture_normalizations (
  observation_id TEXT PRIMARY KEY REFERENCES wa_capture_observations(id),
  conversation_id TEXT NOT NULL REFERENCES wa_conversations(id),
  sender_contact_id TEXT REFERENCES wa_contacts(id),
  message_id TEXT UNIQUE REFERENCES wa_messages(id),
  status TEXT NOT NULL CHECK (status IN ('MESSAGE_CREATED','CONVERSATION_ONLY','DIRECTION_UNKNOWN')),
  CHECK ((status = 'MESSAGE_CREATED' AND message_id IS NOT NULL) OR
         (status <> 'MESSAGE_CREATED' AND message_id IS NULL))
);
INSERT INTO wa_capture_normalizations SELECT * FROM wa_capture_normalizations_v7;
DROP TABLE wa_capture_normalizations_v7;
CREATE INDEX wa_capture_normalizations_conversation_idx ON wa_capture_normalizations(conversation_id,observation_id);
CREATE TABLE wa_conversation_identities (
  conversation_id TEXT PRIMARY KEY REFERENCES wa_conversations(id),
  account_id TEXT NOT NULL,
  reference_type TEXT NOT NULL CHECK(reference_type IN ('PHONE','GROUP_LOCAL')),
  reference_key TEXT NOT NULL,
  peer_contact_id TEXT REFERENCES wa_contacts(id),
  source TEXT NOT NULL CHECK(source IN ('PROFILE_PHONE','USER_GROUP')),
  confirmed_at TEXT NOT NULL,
  UNIQUE(account_id,reference_type,reference_key)
);
