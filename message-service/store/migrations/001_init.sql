CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS messages (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_id    TEXT NOT NULL,
    receiver_id  TEXT NOT NULL,
    content      TEXT NOT NULL,
    sender_pts   BIGINT NOT NULL,
    receiver_pts BIGINT NOT NULL,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_receiver_pts
    ON messages(receiver_id, receiver_pts);
CREATE INDEX IF NOT EXISTS idx_messages_sender_pts
    ON messages(sender_id, sender_pts);
