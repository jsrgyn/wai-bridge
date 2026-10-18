CREATE TABLE wa_capture_observations (
  id TEXT PRIMARY KEY,
  extension_instance_id TEXT NOT NULL,
  observation_type TEXT NOT NULL CHECK (observation_type IN ('MESSAGE','CONVERSATION_ACTIVITY')),
  capture_state TEXT NOT NULL CHECK (capture_state IN ('DETECTED','CAPTURED','PENDING','FAILED')),
  observed_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  event_id TEXT REFERENCES wa_events(id),
  UNIQUE(extension_instance_id, id)
);
CREATE INDEX wa_capture_observations_recent_idx ON wa_capture_observations(observed_at DESC, id);
