// One-shot schema migration — deploys date_ideas table.
// Hit GET /api/migrate-dates to run. Remove after use.
export async function onRequest(context) {
  const { env } = context;
  const DB = env.DB;
  const results = [];

  const migrations = [
    `CREATE TABLE IF NOT EXISTS date_ideas (
      id            TEXT PRIMARY KEY,
      couple_id     TEXT NOT NULL,
      title         TEXT NOT NULL,
      notes         TEXT DEFAULT '',
      planned_date  TEXT,
      category      TEXT DEFAULT '',
      completed     INTEGER DEFAULT 0,
      completed_by  TEXT,
      completed_at  INTEGER,
      created_by    TEXT NOT NULL,
      created_at    INTEGER DEFAULT (strftime('%s','now')),
      updated_at    INTEGER DEFAULT (strftime('%s','now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_date_ideas_couple
       ON date_ideas (couple_id, completed, created_at DESC)`,
  ];

  for (const sql of migrations) {
    try {
      await DB.prepare(sql).run();
      results.push({ sql: sql.slice(0, 80) + '...', ok: true });
    } catch (err) {
      results.push({ sql: sql.slice(0, 80) + '...', ok: false, error: err.message });
    }
  }

  return new Response(JSON.stringify({ migrations: results }), {
    headers: { 'content-type': 'application/json' },
  });
}
