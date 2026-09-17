#!/usr/bin/env node
/**
 * Regression test for the shared couple keys (Date Ideas / Photos / couple settings).
 *
 * Bug it guards: those tables were keyed on the caller's OWN user id, so each
 * partner wrote into a private bucket and never saw the other's rows. They must
 * key on the couple's real shared id — Supabase `couple_members.couple_id` —
 * which `resolveCoupleKey()` in functions/api/[[path]].js resolves from the
 * caller's own JWT (never from a client-supplied id).
 *
 * Runs the REAL Pages Function against a REAL sqlite engine (node:sqlite) with
 * the REAL schema from schema.sql. Fixtures are synthetic — no live data.
 *
 * Run with `npm test`.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const SUPABASE_URL = 'https://supabase.test';
const R2 = 'https://r2.test';

// ── fixtures (synthetic) ────────────────────────────────────────────────────
const A = 'user-a', B = 'user-b', COUPLE = 'couple-1';                  // paired, split buckets
const S = 'solo-user', SP = 'solo-partner', SOLO_COUPLE = 'couple-2';   // pairs after writing
const N1 = 'new-a', N2 = 'new-b', NEW_COUPLE = 'couple-3';              // brand new
const X = 'other-user', X_COUPLE = 'couple-x';                          // stranger

const TOKENS = new Map(Object.entries({ a: A, b: B, s: S, sp: SP, n1: N1, n2: N2, x: X }));
const MEMBERS = [
  { user_id: A, couple_id: COUPLE }, { user_id: B, couple_id: COUPLE },
  { user_id: X, couple_id: X_COUPLE },
];

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
// the handler logs every request as JSON — that noise is not this test's output
const say = console.log.bind(console);
console.log = (...a) => { if (!String(a[0]).startsWith('{"ts"')) say(...a); };

// ── real handler, loaded as ESM (the [[path]].js file lives in a CJS package) ─
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-test-'));
fs.copyFileSync(path.join(ROOT, 'functions/api/[[path]].js'), path.join(tmp, 'api.mjs'));
const { onRequest } = await import(pathToFileURL(path.join(tmp, 'api.mjs')).href);

// ── fake D1 binding: real SQLite, real schema.sql tables ────────────────────
const sqlite = new DatabaseSync(':memory:');
const schemaSql = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8')
  .split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
for (const stmt of schemaSql.split(';')) if (/^\s*CREATE\b/i.test(stmt)) sqlite.exec(stmt);
const writes = [];
const prepare = sql => ({
  bind: (...p) => ({
    all: async () => ({ results: sqlite.prepare(sql).all(...p) }),
    first: async () => sqlite.prepare(sql).get(...p) ?? null,
    run: async () => { writes.push(sql); return { meta: { changes: Number(sqlite.prepare(sql).run(...p).changes) } }; },
  }),
});

// ── fake Supabase + R2 ──────────────────────────────────────────────────────
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
  if (u.startsWith(`${SUPABASE_URL}/auth/v1/user`)) {
    const id = TOKENS.get(String(opts.headers?.authorization || '').replace(/^Bearer\s+/i, ''));
    return id ? json({ id, email: `${id}@test` }) : json({}, 401);
  }
  if (u.startsWith(`${SUPABASE_URL}/rest/v1/couple_members`)) {
    const q = new URL(u).searchParams;
    const mine = (q.get('user_id') || '').replace(/^eq\./, '');
    const cid = (q.get('couple_id') || '').replace(/^eq\./, '');
    if (q.has('user_id')) return json(MEMBERS.filter(m => m.user_id === mine).map(m => ({ couple_id: m.couple_id })));
    return json(MEMBERS.filter(m => m.couple_id === cid).map(m => ({ user_id: m.user_id })));   // same-couple RLS
  }
  return nativeFetch(url, opts);
};

const env = {
  DB: { prepare },
  VIDEOS: { delete: async () => {} },
  R2_PUBLIC_URL: R2,
  SUPABASE_URL,
  SUPABASE_ANON_KEY: 'anon-stub',
  DEFAULT_TENANT_ID: 'default',
};
const call = async (method, urlPath, { token, body, tenant } = {}) => {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (tenant) headers['x-tenant-id'] = tenant;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await onRequest({
    request: new Request(`https://loveflix.us${urlPath}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env, waitUntil: () => {},
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const rows = table => sqlite.prepare(`SELECT * FROM ${table}`).all();
const buckets = (table, col) => sqlite.prepare(`SELECT ${col} k, COUNT(*) n FROM ${table} GROUP BY ${col}`).all();

// legacy data: A added 2 ideas + 2 photos, B added 1 idea — the bug's shape
const addIdea = (id, couple, title, created_by, ts, completed = 0) => sqlite.prepare(
  `INSERT INTO date_ideas (id, couple_id, title, completed, created_by, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
).run(id, couple, title, completed, created_by, ts, ts);
const addPhoto = (id, couple, url, uploaded_by, ts) => sqlite.prepare(
  'INSERT INTO couple_photos (id, couple_id, url, uploaded_by, created_at) VALUES (?,?,?,?,?)'
).run(id, couple, url, uploaded_by, ts);

addIdea('i1', A, 'idea A1', A, 10);
addIdea('i2', A, 'idea A2', A, 11, 1);
addIdea('i3', B, 'idea B1', B, 12);
addPhoto('p1', A, `${R2}/images/a/1.jpg`, A, 20);
addPhoto('p2', A, `${R2}/images/a/2.jpg`, A, 21);
sqlite.prepare('INSERT INTO couple_settings VALUES (?,?,?,?,?,?,?,?,?)')
  .run(B, '2024-02-03', 'Bee', 'Ay', 0, '#e50914', 1, 'private', 100);
sqlite.prepare('INSERT INTO couple_settings VALUES (?,?,?,?,?,?,?,?,?)')
  .run(A, '2024-02-03', 'Ay', 'Bee', 1, '#1d4ed8', 0, 'private', 200);

const beforeRows = { ideas: rows('date_ideas').map(r => [r.id, r.title, r.created_by]), photos: rows('couple_photos').map(r => [r.id, r.url]) };

// ═══ 1. the bug: two buckets, neither partner sees the other ═══════════════
const aIdeas = await call('GET', '/api/date-ideas', { token: 'a' });
const bIdeas = await call('GET', '/api/date-ideas', { token: 'b' });
const bPhotos = await call('GET', '/api/couple/photos', { token: 'b' });
console.log(`  before fix requests: A sees ${aIdeas.json.ideas.length} ideas, B sees ${bIdeas.json.ideas.length} ideas / ${bPhotos.json.photos.length} photos`);
check('both partners now see ALL ideas (3) and photos (2)',
  aIdeas.json.ideas.length === 3 && bIdeas.json.ideas.length === 3 && bPhotos.json.photos.length === 2);
check('both user-id buckets collapsed onto the couple key',
  buckets('date_ideas', 'couple_id').length === 1 && buckets('date_ideas', 'couple_id')[0].k === COUPLE &&
  buckets('couple_photos', 'couple_id').length === 1 && buckets('couple_photos', 'couple_id')[0].k === COUPLE);

// ═══ 2. the merge loses nothing and cannot duplicate ═══════════════════════
check('every idea row survived unchanged (ids + content)',
  JSON.stringify(rows('date_ideas').map(r => [r.id, r.title, r.created_by])) === JSON.stringify(beforeRows.ideas));
check('every photo row survived unchanged (ids + url)',
  JSON.stringify(rows('couple_photos').map(r => [r.id, r.url])) === JSON.stringify(beforeRows.photos));
const settings = rows('couple_settings');
console.log(`  couple_settings: ${settings.length} row(s), anniversary=${settings[0]?.anniversary_date}`);
check('one couple_settings row, values merged not lost', settings.length === 1 && settings[0].tenant_id === COUPLE &&
  settings[0].anniversary_date === '2024-02-03' && settings[0].partner_1_name && settings[0].partner_2_name);
check('a lock on either partner\'s settings carries over', settings[0].is_locked === 1);

// ═══ 3. the sweep is idempotent ════════════════════════════════════════════
writes.length = 0;
await call('GET', '/api/couple/photos', { token: 'a' });
await call('GET', '/api/date-ideas', { token: 'b' });
check('second pass performs no writes', writes.filter(s => /^\s*(UPDATE|INSERT|DELETE)/i.test(s)).length === 0);

// ═══ 4. writes are shared, ownership checks agree with the read key ════════
const newIdea = await call('POST', '/api/date-ideas', { token: 'a', body: { title: 'shared idea' } });
const newPhoto = await call('POST', '/api/couple/photos', { token: 'a', body: { url: `${R2}/images/a/3.jpg` } });
const bSeesIdea = await call('GET', '/api/date-ideas', { token: 'b' });
const bSeesPhoto = await call('GET', '/api/couple/photos', { token: 'b' });
check('a row one partner creates is keyed on the couple, not on that user',
  sqlite.prepare('SELECT couple_id FROM date_ideas WHERE id = ?').get(newIdea.json.idea.id).couple_id === COUPLE &&
  sqlite.prepare('SELECT couple_id FROM couple_photos WHERE id = ?').get(newPhoto.json.photo.id).couple_id === COUPLE);
check('the other partner sees both immediately',
  bSeesIdea.json.ideas.some(i => i.id === newIdea.json.idea.id) && bSeesPhoto.json.photos.some(p => p.id === newPhoto.json.photo.id));
check('the other partner can complete my idea (no 403)',
  (await call('PATCH', `/api/date-ideas/${newIdea.json.idea.id}`, { token: 'b', body: { completed: true } })).status === 200);
check('the other partner can delete my photo (no 403)',
  (await call('DELETE', `/api/couple/photos?id=${newPhoto.json.photo.id}`, { token: 'b' })).status === 200);
check('a stranger still gets 403 on that photo',
  (await call('DELETE', '/api/couple/photos?id=p1', { token: 'x' })).status === 403);
check('a stranger\'s album is still their own',
  (await call('GET', '/api/couple/photos', { token: 'x' })).json.photos.length === 0);
check('unauthenticated is still 401', (await call('GET', '/api/couple/photos')).status === 401);

// ═══ 5. a brand-new couple is shared from day one ══════════════════════════
MEMBERS.push({ user_id: N1, couple_id: NEW_COUPLE }, { user_id: N2, couple_id: NEW_COUPLE });
const firstPhoto = await call('POST', '/api/couple/photos', { token: 'n1', body: { url: `${R2}/images/n/1.jpg` } });
const partnerView = await call('GET', '/api/couple/photos', { token: 'n2' });
check('new couple: partner 2 sees partner 1\'s first photo, no migration involved',
  partnerView.json.photos.length === 1 && partnerView.json.photos[0].id === firstPhoto.json.photo.id);

// ═══ 6. an account that pairs later keeps its data ═════════════════════════
const soloIdea = await call('POST', '/api/date-ideas', { token: 's', body: { title: 'before pairing' } });
check('unpaired account still writes into its own bucket',
  sqlite.prepare('SELECT couple_id FROM date_ideas WHERE id = ?').get(soloIdea.json.idea.id).couple_id === S);
MEMBERS.push({ user_id: S, couple_id: SOLO_COUPLE }, { user_id: SP, couple_id: SOLO_COUPLE });
check('after pairing the partner sees the pre-pairing idea',
  (await call('GET', '/api/date-ideas', { token: 'sp' })).json.ideas.some(i => i.id === soloIdea.json.idea.id));
check('and it is adopted onto the couple key exactly once',
  sqlite.prepare('SELECT couple_id FROM date_ideas WHERE id = ?').get(soloIdea.json.idea.id).couple_id === SOLO_COUPLE &&
  sqlite.prepare('SELECT COUNT(*) n FROM date_ideas WHERE title = ?').get('before pairing').n === 1);

// ═══ 7. couple settings are shared, not copied per user ════════════════════
await call('PATCH', '/api/couple/settings', { token: 'a', body: { anniversary_date: '2024-02-04' } });
const bSettings = await call('GET', '/api/couple/settings', { token: 'b' });
check('a settings change by one partner is what the other reads back',
  bSettings.json.settings.anniversary_date === '2024-02-04');
check('still exactly one settings row for the couple', rows('couple_settings').length === 1);

fs.rmSync(tmp, { recursive: true, force: true });
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) console.log(`FAILED: ${failed.map(f => f.name).join(' | ')}`);
process.exit(failed.length ? 1 : 0);
