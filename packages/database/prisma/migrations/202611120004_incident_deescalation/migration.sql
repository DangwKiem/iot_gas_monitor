ALTER TABLE alert_events DROP CONSTRAINT event_transition;
ALTER TABLE alert_events ADD CONSTRAINT event_transition
  CHECK (transition IN ('started','escalated','deescalated','ended'));
