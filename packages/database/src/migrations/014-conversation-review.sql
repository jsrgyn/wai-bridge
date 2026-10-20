CREATE TABLE wa_conversation_reviews (
  conversation_id TEXT PRIMARY KEY REFERENCES wa_conversations(id),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
  verified_revision INTEGER NOT NULL DEFAULT 0 CHECK(verified_revision>=0 AND verified_revision<=revision),
  acknowledged_revision INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged_revision>=0 AND acknowledged_revision<=verified_revision),
  signal_count INTEGER NOT NULL DEFAULT 0 CHECK(signal_count>=0),
  unread_count INTEGER CHECK(unread_count IS NULL OR unread_count>=0),
  unread_observed_at TEXT,
  last_activity_at TEXT NOT NULL,
  last_sync_request_id TEXT REFERENCES wa_dialogue_sync_requests(id),
  last_sync_at TEXT,
  last_read_confirmed_at TEXT
);
ALTER TABLE wa_dialogue_sync_requests ADD COLUMN review_conversation_id TEXT REFERENCES wa_conversations(id);
ALTER TABLE wa_dialogue_sync_requests ADD COLUMN review_revision INTEGER;
CREATE INDEX wa_dialogue_sync_review_idx ON wa_dialogue_sync_requests(review_conversation_id,created_at);
CREATE TABLE wa_conversation_review_signals (
  observation_id TEXT PRIMARY KEY REFERENCES wa_capture_observations(id),
  conversation_id TEXT NOT NULL REFERENCES wa_conversations(id),
  revision INTEGER NOT NULL,
  UNIQUE(conversation_id,revision)
);
CREATE TABLE wa_conversation_review_links (
  conversation_id TEXT NOT NULL REFERENCES wa_conversations(id),
  related_conversation_id TEXT NOT NULL REFERENCES wa_conversations(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY(conversation_id,related_conversation_id),
  CHECK(conversation_id<>related_conversation_id)
);
-- Conservatively seed existing observations, never infer previous human confirmation.
-- Snapshot imports are not fresh notifications; exclude message IDs reconciled by jobs.
INSERT INTO wa_conversation_review_signals(observation_id,conversation_id,revision)
SELECT o.id,n.conversation_id,
  ROW_NUMBER() OVER(PARTITION BY n.conversation_id ORDER BY o.observed_at,o.id)
FROM wa_capture_observations o JOIN wa_capture_normalizations n ON n.observation_id=o.id
WHERE o.observation_type='CONVERSATION_ACTIVITY' OR (
  o.observation_type='MESSAGE' AND json_extract(o.payload_json,'$.direction')='INBOUND'
  AND n.status IN ('MESSAGE_CREATED','MESSAGE_UPDATED') AND NOT EXISTS (
    SELECT 1 FROM wa_dialogue_sync_requests j,json_each(j.result_json,'$.messageIds') m
    WHERE j.status='SUCCEEDED' AND m.value=n.message_id
  )
);
INSERT INTO wa_conversation_reviews(conversation_id,revision,signal_count,last_activity_at)
SELECT s.conversation_id,MAX(s.revision),COUNT(*),MAX(o.observed_at)
FROM wa_conversation_review_signals s JOIN wa_capture_observations o ON o.id=s.observation_id
GROUP BY s.conversation_id;
