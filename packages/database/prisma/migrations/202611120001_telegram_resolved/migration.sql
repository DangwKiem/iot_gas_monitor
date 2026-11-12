-- Notification levels include recovery; alert_incidents.severity is unchanged.
ALTER TABLE telegram_notifications
  DROP CONSTRAINT telegram_notifications_severity_check;
ALTER TABLE telegram_notifications
  ADD CONSTRAINT telegram_notifications_severity_check
  CHECK (severity IN ('warning', 'critical', 'resolved'));
