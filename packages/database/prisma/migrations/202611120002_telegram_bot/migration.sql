CREATE TABLE telegram_connections (
 telegram_user_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL,
 user_id UUID UNIQUE REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
 selected_device_id UUID, message_id INTEGER, callback_token TEXT NOT NULL DEFAULT '',
 callback_expires_at TIMESTAMPTZ(3), actions JSONB NOT NULL DEFAULT '[]',
 view JSONB NOT NULL DEFAULT '{"screen":"menu"}', last_update_id BIGINT NOT NULL DEFAULT -1,
 pending BOOLEAN NOT NULL DEFAULT false, next_allowed_at TIMESTAMPTZ(3)
);
CREATE TABLE telegram_link_codes (
 user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
 token_hash TEXT NOT NULL UNIQUE,
 session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE ON UPDATE CASCADE,
 expires_at TIMESTAMPTZ(3) NOT NULL
);
CREATE TABLE telegram_bot_cursors (
 id TEXT PRIMARY KEY, "offset" BIGINT NOT NULL DEFAULT 0, username TEXT,
 lease_token UUID, lease_until TIMESTAMPTZ(3)
);
