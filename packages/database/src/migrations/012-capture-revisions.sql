ALTER TABLE wa_capture_normalizations RENAME TO wa_capture_normalizations_v11;
CREATE TABLE wa_capture_normalizations (
 observation_id TEXT PRIMARY KEY REFERENCES wa_capture_observations(id),
 conversation_id TEXT NOT NULL REFERENCES wa_conversations(id),
 sender_contact_id TEXT REFERENCES wa_contacts(id),
 message_id TEXT REFERENCES wa_messages(id),
 status TEXT NOT NULL CHECK(status IN ('MESSAGE_CREATED','MESSAGE_UPDATED','CONVERSATION_ONLY','DIRECTION_UNKNOWN')),
 CHECK ((status IN ('MESSAGE_CREATED','MESSAGE_UPDATED') AND message_id IS NOT NULL) OR (status IN ('CONVERSATION_ONLY','DIRECTION_UNKNOWN') AND message_id IS NULL))
);
INSERT INTO wa_capture_normalizations SELECT * FROM wa_capture_normalizations_v11;
DROP TABLE wa_capture_normalizations_v11;
CREATE INDEX wa_capture_normalizations_conversation_idx ON wa_capture_normalizations(conversation_id,observation_id);
CREATE INDEX wa_capture_normalizations_message_idx ON wa_capture_normalizations(message_id);
CREATE TABLE wa_capture_message_refs (
 extension_instance_id TEXT NOT NULL,
 reference_key TEXT NOT NULL,
 conversation_id TEXT NOT NULL REFERENCES wa_conversations(id),
 message_id TEXT REFERENCES wa_messages(id),
 latest_revision INTEGER NOT NULL CHECK(latest_revision>0),
 latest_observation_id TEXT NOT NULL REFERENCES wa_capture_observations(id),
 first_observed_at TEXT NOT NULL,
 PRIMARY KEY(extension_instance_id,reference_key)
);
