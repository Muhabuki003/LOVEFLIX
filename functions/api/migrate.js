// LoveFlix D1 Schema Migration — runs once when deployed
// This function applies schema changes to the D1 database.
// Trigger it by visiting /api/migrate after deploy.
// It uses the D1 binding from wrangler.toml, which is always available
// to Pages Functions — no separate API token needed.

export async function onRequest(context) {
  const { env } = context;
  const DB = env.DB;
  
  if (!DB) {
    return new Response(JSON.stringify({ error: 'D1 binding not available' }), {
      status: 500,
      headers: { 'content-type': 'application/json' }
    });
  }
  
  const migrations = [
    // Ensure music_state table exists
    `CREATE TABLE IF NOT EXISTS music_state (
      user_id    TEXT PRIMARY KEY,
      couple_id  TEXT NOT NULL,
      youtube_id TEXT,
      title      TEXT,
      artist     TEXT,
      is_playing INTEGER DEFAULT 0,
      position   INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    )`,
    
    // Ensure is_public column on couple_playlists
    `ALTER TABLE couple_playlists ADD COLUMN is_public INTEGER DEFAULT 1`,

    // Cross-provider playlists: songs are matched by ISRC (Spotify/Apple) or
    // title+artist search (YouTube), so store the ISRC when we have it.
    `ALTER TABLE couple_playlist_songs ADD COLUMN isrc TEXT`,
    
    // Ensure couple_settings exists (idempotent)
    `CREATE TABLE IF NOT EXISTS couple_settings (
      tenant_id             TEXT PRIMARY KEY,
      anniversary_date      TEXT,
      partner_1_name        TEXT,
      partner_2_name        TEXT,
      is_locked             INTEGER DEFAULT 0,
      brand_accent_color    TEXT DEFAULT '#e50914',
      notifications_enabled INTEGER DEFAULT 1,
      privacy_level         TEXT DEFAULT 'private',
      updated_at            INTEGER DEFAULT (strftime('%s','now'))
    )`,
  ];
  
  const results = [];
  for (const sql of migrations) {
    try {
      await DB.prepare(sql).run();
      results.push({ sql: sql.slice(0, 60) + '...', ok: true });
    } catch (err) {
      // ALTER TABLE ADD COLUMN will fail if column already exists — that's OK
      if (err.message && err.message.includes('duplicate column')) {
        results.push({ sql: sql.slice(0, 60) + '...', ok: true, note: 'column already exists' });
      } else {
        results.push({ sql: sql.slice(0, 60) + '...', ok: false, error: err.message });
      }
    }
  }
  
  return new Response(JSON.stringify({ ok: true, migrations: results }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}
