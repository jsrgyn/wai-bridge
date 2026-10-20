CREATE TABLE wa_contact_catalog (
 contact_id TEXT PRIMARY KEY REFERENCES wa_contacts(id), name TEXT, nickname TEXT, full_name TEXT, phone TEXT,
 relationships_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(relationships_json)),
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0)
);
CREATE TABLE wa_management_replays (
 idempotency_key TEXT PRIMARY KEY, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),result_json TEXT NOT NULL CHECK(json_valid(result_json))
);
CREATE TABLE wa_reference_decisions (
 left_id TEXT NOT NULL REFERENCES wa_conversations(id),right_id TEXT NOT NULL REFERENCES wa_conversations(id),decision TEXT NOT NULL CHECK(decision IN ('LINK','DISMISS')),at TEXT NOT NULL,PRIMARY KEY(left_id,right_id),CHECK(left_id<right_id)
);
CREATE TABLE wa_conversation_policies (
 conversation_id TEXT PRIMARY KEY REFERENCES wa_conversations(id),favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN (0,1)),priority INTEGER NOT NULL DEFAULT 0 CHECK(priority BETWEEN -100 AND 100),batch_mode TEXT NOT NULL DEFAULT 'INCLUDE' CHECK(batch_mode IN ('INCLUDE','EXCLUDE','INDIVIDUAL_ONLY')),updated_at TEXT NOT NULL
);
CREATE TABLE wa_extension_telemetry (
 extension_instance_id TEXT PRIMARY KEY,payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),updated_at TEXT NOT NULL
);
CREATE TABLE wa_maintenance_settings (id INTEGER PRIMARY KEY CHECK(id=1),payload_json TEXT NOT NULL CHECK(json_valid(payload_json)));
CREATE TABLE wa_backup_runs (
 id TEXT PRIMARY KEY,file_name TEXT NOT NULL UNIQUE,status TEXT NOT NULL CHECK(status IN ('RUNNING','VERIFIED','FAILED','PRUNED')),created_at TEXT NOT NULL,completed_at TEXT,size_bytes INTEGER,code TEXT
);
