-- Speeds up the per-IP auth lockout check (recent auth_failed rows for one actor).
CREATE INDEX idx_audit_event_actor_ts ON audit_log (event, actor, ts);
