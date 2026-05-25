-- LoveFlix D1 migration v2 — add stream_url, youtube_id, duration to playlist songs
-- Run with: wrangler d1 execute loveflix-db --file=./migration_v2_playlist_songs.sql --remote

ALTER TABLE couple_playlist_songs ADD COLUMN stream_url  TEXT;
ALTER TABLE couple_playlist_songs ADD COLUMN youtube_id  TEXT;
ALTER TABLE couple_playlist_songs ADD COLUMN duration    INTEGER DEFAULT 30;
