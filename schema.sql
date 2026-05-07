-- LoveFlix D1 schema
-- Run with: wrangler d1 execute loveflix-db --file=./schema.sql --remote

CREATE TABLE IF NOT EXISTS tenants (
  id            TEXT PRIMARY KEY,
  subdomain     TEXT UNIQUE,
  couple_name   TEXT,
  accent_color  TEXT DEFAULT '#e50914',
  creator_id    TEXT,
  partner_email TEXT,
  created_at    INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS videos (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL,
  title            TEXT NOT NULL,
  description      TEXT,
  date             TEXT,
  category         TEXT,
  thumbnail_url    TEXT,
  video_url        TEXT,
  duration_seconds INTEGER DEFAULT 0,
  is_published     INTEGER DEFAULT 1,
  display_order    INTEGER DEFAULT 0,
  created_at       INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_videos_tenant
  ON videos (tenant_id, is_published, display_order);

CREATE TABLE IF NOT EXISTS watch_progress (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  video_id          TEXT NOT NULL,
  progress_seconds  INTEGER DEFAULT 0,
  completed         INTEGER DEFAULT 0,
  last_watched_at   INTEGER DEFAULT (strftime('%s','now')),
  UNIQUE (user_id, video_id)
);
CREATE INDEX IF NOT EXISTS idx_progress_user
  ON watch_progress (user_id, last_watched_at DESC);

CREATE TABLE IF NOT EXISTS favorites (
  user_id    TEXT NOT NULL,
  video_id   TEXT NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s','now')),
  PRIMARY KEY (user_id, video_id)
);

-- Default tenant so the app works out of the box.
INSERT OR IGNORE INTO tenants (id, subdomain, couple_name, accent_color)
VALUES ('default', 'app', 'LoveFlix', '#e50914');
