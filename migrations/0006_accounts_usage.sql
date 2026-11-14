-- Accounts own agents and are the unit usage is metered against. A deployment starts with one account,
-- 'default', which owns every existing agent.
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  plan TEXT NOT NULL DEFAULT 'free',
  created_at INTEGER NOT NULL
);

INSERT INTO accounts (id, plan, created_at) VALUES ('default', 'free', CAST(strftime('%s', 'now') AS INTEGER) * 1000);

-- No REFERENCES clause: SQLite refuses ADD COLUMN with a foreign key and a non-NULL default.
ALTER TABLE agents ADD COLUMN account_id TEXT NOT NULL DEFAULT 'default';
CREATE INDEX idx_agents_account ON agents (account_id);

-- Messages accepted for delivery per account per UTC calendar month (period = 'YYYY-MM').
CREATE TABLE usage_counters (
  account_id TEXT NOT NULL,
  period TEXT NOT NULL,
  messages_sent INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, period)
) WITHOUT ROWID;
