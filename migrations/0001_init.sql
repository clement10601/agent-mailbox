CREATE TABLE agents (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1))
);

CREATE TABLE keys (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL REFERENCES agents(name),
  key_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  reply_to TEXT,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  subject TEXT,
  body TEXT,
  data TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  acked_at INTEGER
);

CREATE TABLE blocks (
  agent_name TEXT NOT NULL,
  blocked_sender TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (agent_name, blocked_sender)
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  event TEXT NOT NULL,
  actor TEXT,
  target TEXT,
  subject TEXT,
  body TEXT,
  expires_at INTEGER
);

CREATE INDEX idx_messages_inbox ON messages (to_agent, acked_at, created_at);
CREATE INDEX idx_messages_thread ON messages (thread_id);
CREATE INDEX idx_messages_expires ON messages (expires_at);
CREATE INDEX idx_audit_expires ON audit_log (expires_at);
