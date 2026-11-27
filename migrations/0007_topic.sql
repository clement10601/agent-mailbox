ALTER TABLE messages ADD COLUMN topic TEXT;

CREATE INDEX idx_messages_inbox_topic ON messages (to_agent, topic, acked_at, created_at);
CREATE INDEX idx_messages_inbox_from ON messages (to_agent, from_agent, acked_at, created_at);
