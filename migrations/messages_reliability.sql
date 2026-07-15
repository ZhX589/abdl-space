-- 私信可靠性：消息幂等 + 持久化事件 + outbox
-- Task 2: D1 reliability schema

-- 消息幂等字段
ALTER TABLE messages ADD COLUMN client_msg_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_msg
ON messages(sender_id, client_msg_id)
WHERE client_msg_id IS NOT NULL;

-- 持久化事件流（全局自增，单用户跳号正常）
CREATE TABLE IF NOT EXISTS message_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  message_id INTEGER,
  peer_id INTEGER NOT NULL,
  read_up_to_id INTEGER,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_message_events_sync ON message_events(user_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_event_new
ON message_events(user_id, event_type, message_id)
WHERE event_type = 'message.new';
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_event_read
ON message_events(user_id, event_type, peer_id, read_up_to_id)
WHERE event_type = 'message.read';

-- Outbox（Queue 消费后标记 dispatched_at）
CREATE TABLE IF NOT EXISTS message_outbox (
  event_id INTEGER PRIMARY KEY,
  dispatched_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY(event_id) REFERENCES message_events(id)
);
CREATE INDEX IF NOT EXISTS idx_message_outbox_pending
ON message_outbox(dispatched_at, next_attempt_at);
