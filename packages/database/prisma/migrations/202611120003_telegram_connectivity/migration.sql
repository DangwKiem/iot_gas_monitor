ALTER TABLE telegram_notifications ALTER COLUMN incident_id DROP NOT NULL;
ALTER TABLE telegram_notifications ADD COLUMN status_history_id BIGINT UNIQUE
  REFERENCES device_status_history(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE telegram_notifications DROP CONSTRAINT telegram_notifications_severity_check;
ALTER TABLE telegram_notifications ADD CONSTRAINT telegram_notifications_severity_check
  CHECK (severity IN ('warning','critical','resolved','offline','online'));
ALTER TABLE telegram_notifications ADD CONSTRAINT telegram_notifications_target_check
  CHECK ((incident_id IS NOT NULL AND status_history_id IS NULL AND severity IN ('warning','critical','resolved'))
    OR (incident_id IS NULL AND status_history_id IS NOT NULL AND severity IN ('offline','online')));
