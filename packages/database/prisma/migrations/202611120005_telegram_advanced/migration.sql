ALTER TABLE telegram_connections
 ADD COLUMN link_version UUID NOT NULL DEFAULT gen_random_uuid(),
 ADD COLUMN warning_enabled BOOLEAN NOT NULL DEFAULT true,
 ADD COLUMN tracked_device_id UUID,
 ADD COLUMN report_frequency TEXT NOT NULL DEFAULT 'off' CHECK (report_frequency IN ('off','daily','weekly')),
 ADD COLUMN report_minute INTEGER NOT NULL DEFAULT 480 CHECK (report_minute BETWEEN 0 AND 1439),
 ADD COLUMN report_weekday INTEGER NOT NULL DEFAULT 1 CHECK (report_weekday BETWEEN 0 AND 6),
 ADD COLUMN next_report_at TIMESTAMPTZ(3),
 ADD COLUMN query_allowed_at TIMESTAMPTZ(3),
 ADD COLUMN photo_message_id INTEGER;
CREATE TABLE telegram_bot_deliveries (
 id UUID PRIMARY KEY,
 connection_id TEXT NOT NULL REFERENCES telegram_connections(telegram_user_id) ON UPDATE CASCADE ON DELETE CASCADE,
 link_version UUID NOT NULL,
 event_key TEXT NOT NULL,
 kind TEXT NOT NULL CHECK (kind IN ('incident','connectivity','report','test')),
 incident_id UUID REFERENCES alert_incidents(id) ON UPDATE CASCADE ON DELETE RESTRICT,
 status_history_id BIGINT REFERENCES device_status_history(id) ON UPDATE CASCADE ON DELETE RESTRICT,
 severity TEXT,
 period_from TIMESTAMPTZ(3), period_to TIMESTAMPTZ(3),
 status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','expired','skipped')),
 attempts INTEGER NOT NULL DEFAULT 0,
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 next_attempt_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 expires_at TIMESTAMPTZ(3) NOT NULL,
 lease_token UUID, lease_until TIMESTAMPTZ(3), sent_at TIMESTAMPTZ(3), last_error_code TEXT,
 CHECK ((kind='incident' AND incident_id IS NOT NULL AND status_history_id IS NULL AND severity IN ('warning','critical','resolved'))
 OR (kind='connectivity' AND status_history_id IS NOT NULL AND incident_id IS NULL AND severity IN ('online','offline'))
 OR (kind='report' AND incident_id IS NULL AND status_history_id IS NULL AND period_from IS NOT NULL AND period_to>period_from)
 OR (kind='test' AND incident_id IS NULL AND status_history_id IS NULL)),
 UNIQUE(connection_id,link_version,event_key)
);
CREATE INDEX telegram_bot_deliveries_status_next_attempt_at_idx ON telegram_bot_deliveries(status,next_attempt_at);
CREATE INDEX telegram_connections_next_report_at_idx ON telegram_connections(next_report_at) WHERE next_report_at IS NOT NULL;
CREATE INDEX telegram_bot_deliveries_incident_idx ON telegram_bot_deliveries(incident_id);
CREATE INDEX telegram_bot_deliveries_history_idx ON telegram_bot_deliveries(status_history_id);
