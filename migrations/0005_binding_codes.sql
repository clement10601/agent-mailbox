-- One-time binding codes: the owner mints one for an agent (admin_create_binding_code) and pastes it into the
-- OAuth consent page instead of the admin key. Only the SHA-256 hash is stored; redeeming deletes the row.
CREATE TABLE binding_codes (
  code_hash TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  create_agent INTEGER NOT NULL DEFAULT 0 CHECK (create_agent IN (0, 1)),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX binding_codes_expires ON binding_codes (expires_at);
