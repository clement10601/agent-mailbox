-- Binds each MCP session id to the identity that created it, so a session can only be used
-- with a key that resolves to that same identity (checked in the worker on every request).
CREATE TABLE mcp_sessions (
  id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX mcp_sessions_expires ON mcp_sessions (expires_at);
