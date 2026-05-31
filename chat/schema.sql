-- LoveFlix Chat — D1 schema
-- Run once after creating the D1 database:
--   wrangler d1 execute loveflix-chat --remote --file=schema.sql

-- One row per couple; id = couple_id UUID from Supabase
CREATE TABLE IF NOT EXISTS couple_rooms (
  id         TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

-- All messages for a couple, keyed by couple_id (room_id)
CREATE TABLE IF NOT EXISTS couple_messages (
  id          TEXT PRIMARY KEY,
  room_id     TEXT NOT NULL,    -- couple_id UUID
  sender_id   TEXT NOT NULL,    -- Supabase auth.users UUID
  sender_name TEXT NOT NULL,    -- display_name from couple_members
  text        TEXT NOT NULL,
  created_at  INTEGER NOT NULL, -- Unix ms timestamp
  FOREIGN KEY (room_id) REFERENCES couple_rooms(id)
);

CREATE INDEX IF NOT EXISTS idx_messages_room ON couple_messages(room_id, created_at);
