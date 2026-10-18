CREATE TABLE wa_capture_normalizations (
  observation_id TEXT PRIMARY KEY REFERENCES wa_capture_observations(id),
  conversation_id TEXT NOT NULL UNIQUE REFERENCES wa_conversations(id),
  sender_contact_id TEXT REFERENCES wa_contacts(id),
  message_id TEXT UNIQUE REFERENCES wa_messages(id),
  status TEXT NOT NULL CHECK (status IN ('MESSAGE_CREATED','CONVERSATION_ONLY','DIRECTION_UNKNOWN')),
  CHECK ((status = 'MESSAGE_CREATED' AND message_id IS NOT NULL) OR
         (status <> 'MESSAGE_CREATED' AND message_id IS NULL))
);
