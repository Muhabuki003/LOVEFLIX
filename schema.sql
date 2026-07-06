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

CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id  TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  updated_at INTEGER DEFAULT (strftime('%s','now'))
);

-- ─── MUSIC FEATURE TABLES ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS couple_playlists (
  id        TEXT PRIMARY KEY,
  couple_id TEXT NOT NULL,
  name      TEXT NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s','now')),
  updated_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_couple_playlists_couple_id
  ON couple_playlists (couple_id);

CREATE TABLE IF NOT EXISTS couple_playlist_songs (
  id                    TEXT PRIMARY KEY,
  playlist_id           TEXT NOT NULL,
  soundcloud_track_id   INTEGER NOT NULL,
  title                 TEXT NOT NULL,
  artist                TEXT,
  artwork_url           TEXT,
  stream_url            TEXT,
  youtube_id            TEXT,
  isrc                  TEXT,
  duration              INTEGER DEFAULT 30,
  added_by_user_id      TEXT,
  added_at              INTEGER DEFAULT (strftime('%s','now')),
  FOREIGN KEY (playlist_id) REFERENCES couple_playlists(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_playlist_songs_playlist_id
  ON couple_playlist_songs (playlist_id);

CREATE TABLE IF NOT EXISTS couple_music_plays (
  id                   TEXT PRIMARY KEY,
  couple_id            TEXT NOT NULL,
  soundcloud_track_id  INTEGER NOT NULL,
  title                TEXT NOT NULL,
  artist               TEXT,
  played_by_user_id    TEXT,
  played_at            INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_music_plays_couple_id
  ON couple_music_plays (couple_id);
CREATE INDEX IF NOT EXISTS idx_music_plays_played_at
  ON couple_music_plays (played_at DESC);
-- ─────────────────────────────────────────────────────────────────────────────

-- Per-couple settings with locked identity fields and editable preferences
CREATE TABLE IF NOT EXISTS couple_settings (
  tenant_id             TEXT PRIMARY KEY,
  anniversary_date      TEXT,
  partner_1_name        TEXT,
  partner_2_name        TEXT,
  is_locked             INTEGER DEFAULT 0,
  brand_accent_color    TEXT DEFAULT '#e50914',
  notifications_enabled INTEGER DEFAULT 1,
  privacy_level         TEXT DEFAULT 'private',
  updated_at            INTEGER DEFAULT (strftime('%s','now'))
);

-- Default tenant so the app works out of the box.
INSERT OR IGNORE INTO tenants (id, subdomain, couple_name, accent_color)
VALUES ('default', 'app', 'LoveFlix', '#e50914');
