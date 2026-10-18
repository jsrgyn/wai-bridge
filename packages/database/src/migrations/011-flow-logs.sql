CREATE TABLE wa_flow_logs (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 id TEXT NOT NULL UNIQUE,
 trace_id TEXT NOT NULL,
 resource_id TEXT,
 component TEXT NOT NULL,
 level TEXT NOT NULL,
 received_at TEXT NOT NULL,
 event_json TEXT NOT NULL CHECK(json_valid(event_json))
);
CREATE INDEX wa_flow_logs_trace_idx ON wa_flow_logs(trace_id,sequence DESC);
CREATE INDEX wa_flow_logs_resource_idx ON wa_flow_logs(resource_id,sequence DESC);
CREATE INDEX wa_flow_logs_component_idx ON wa_flow_logs(component,sequence DESC);
CREATE INDEX wa_flow_logs_received_idx ON wa_flow_logs(received_at);
ALTER TABLE wa_outbox ADD COLUMN flow_trace_id TEXT;
UPDATE wa_outbox SET flow_trace_id=id;
CREATE INDEX wa_outbox_flow_trace_idx ON wa_outbox(flow_trace_id);
