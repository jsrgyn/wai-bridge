ALTER TABLE wa_conversation_identities RENAME TO wa_conversation_identities_v8;
CREATE TABLE wa_conversation_identities (
  conversation_id TEXT PRIMARY KEY REFERENCES wa_conversations(id),
  account_id TEXT NOT NULL,
  reference_type TEXT NOT NULL CHECK(reference_type IN ('PHONE','GROUP_LOCAL','UI_CONTEXT')),
  reference_key TEXT NOT NULL,
  peer_contact_id TEXT REFERENCES wa_contacts(id),
  source TEXT NOT NULL CHECK(source IN ('PROFILE_PHONE','USER_GROUP','VISIBLE_UI')),
  confirmed_at TEXT NOT NULL,
  UNIQUE(account_id,reference_type,reference_key)
);
INSERT INTO wa_conversation_identities SELECT * FROM wa_conversation_identities_v8;
DROP TABLE wa_conversation_identities_v8;
