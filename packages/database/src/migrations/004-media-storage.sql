ALTER TABLE wa_media ADD COLUMN processing_status TEXT NOT NULL DEFAULT 'DETECTED'
  CHECK (processing_status IN ('DETECTED','AVAILABLE','CACHING','CACHED','UNAVAILABLE','FAILED','REMOVED'));
ALTER TABLE wa_media ADD COLUMN duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0);
ALTER TABLE wa_media ADD COLUMN caching_started_at TEXT;
ALTER TABLE wa_media ADD COLUMN cached_at TEXT;
ALTER TABLE wa_media ADD COLUMN verified_at TEXT;
ALTER TABLE wa_media ADD COLUMN removed_at TEXT;
ALTER TABLE wa_media ADD COLUMN error_code TEXT;
CREATE INDEX wa_media_retention_idx ON wa_media(processing_status,cached_at,id);
CREATE INDEX wa_media_hash_idx ON wa_media(sha256) WHERE sha256 IS NOT NULL;
CREATE INDEX wa_media_storage_key_idx ON wa_media(storage_key) WHERE storage_key IS NOT NULL;
