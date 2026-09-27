/**
 * Large-video upload — regression test.
 *
 * Root cause being locked down: Cloudflare caps a single Pages Function request
 * body at ~100 MB and kills the connection with a 413, so a long video uploaded in
 * one PUT arrived cut. Files above LF_CHUNK_OVER now go up in <=8 MiB parts and R2
 * re-assembles them; every path verifies the stored size before claiming success.
 *
 * Slices the REAL client code out of admin_upload.html and drives the REAL Pages
 * Function (functions/api/[[path]].js) against a stub R2 binding + stub Supabase
 * auth, so it proves reassembly byte-for-byte without any credentials.
 *
 * Run: node tests/upload-multipart.test.mjs   (also wired into `npm test`)
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import crypto from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`}`);
}

// ─────────────────────────── client: part slicing ───────────────────────────
const html = readFileSync(join(root, 'admin_upload.html'), 'utf8');
const s = html.indexOf('lf-chunk-start'), e = html.indexOf('lf-chunk-end');
const block = html.slice(html.indexOf('\n', s) + 1, html.lastIndexOf('\n', e));
const { lfPartsFor, singleShotUrl, lfUploadErrorText, LF_CHUNK_OVER, LF_CHUNK_FALLBACK } = new Function(
  `${block}\nreturn { lfPartsFor, singleShotUrl, lfUploadErrorText, LF_CHUNK_OVER, LF_CHUNK_FALLBACK };`)();

console.log('— client: part slicing —');
const MB = 1024 * 1024;
check('32 MB file, 8 MB parts -> 4 parts', lfPartsFor(32 * MB, 8 * MB).length, 4);
check('33 MB file, 8 MB parts -> 5 parts', lfPartsFor(33 * MB, 8 * MB).length, 5);
check('0-byte file still yields one part', lfPartsFor(0, 8 * MB).length, 1);
{
  const size = 1.5 * 1024 * MB;                       // a 1.5 GB screen recording
  const parts = lfPartsFor(size, 8 * MB);
  const contiguous = parts.every((p, i) => p.start === (i === 0 ? 0 : parts[i - 1].end));
  const total = parts.reduce((a, p) => a + (p.end - p.start), 0);
  const maxPart = Math.max(...parts.map(p => p.end - p.start));
  check('1.5 GB -> parts are contiguous', contiguous, true);
  check('1.5 GB -> parts cover the whole file', total, size);
  check('1.5 GB -> every part is under Cloudflare\'s ~100 MB cap', maxPart <= 100 * MB, true);
  check('1.5 GB -> part count within R2\'s 10000 limit', parts.length <= 10000, true);
}
check('chunk threshold is below the 100 MB hard cap', LF_CHUNK_OVER < 100 * MB, true);
check('fallback part size is under the cap', LF_CHUNK_FALLBACK <= 10 * MB, true);
check('client uses the multipart create endpoint', html.includes('/api/upload-multipart/create'), true);
check('client uses the multipart part endpoint', html.includes('/api/upload-multipart/part?'), true);
check('client uses the multipart complete endpoint', html.includes('/api/upload-multipart/complete'), true);
check('client verifies the returned size', html.includes('upload incomplete: stored'), true);
check('singleShotUrl appends bytes to a bare url', singleShotUrl('/api/upload-object?key=k', 99), '/api/upload-object?key=k&bytes=99');
check('singleShotUrl uses ? when there is no query', singleShotUrl('/x', 5), '/x?bytes=5');
check('a cut upload reads as plain English, not an error code',
  lfUploadErrorText(new Error('upload_truncated')), 'the upload was cut short — please try again');
check('an unknown error still surfaces something', lfUploadErrorText(new Error('boom')), 'boom');

// ─────────────────────────── server: real endpoints ────────────────────────
const scratch = mkdtempSync(join(tmpdir(), 'lf-mp-'));
const apiPath = join(scratch, 'api.mjs');
writeFileSync(apiPath, readFileSync(join(root, 'functions/api/[[path]].js'), 'utf8'));
const mod = await import(pathToFileURL(apiPath).href);

const USER_ID = 'user-abc';
const supabaseUser = { id: USER_ID, email: 'a@b.c' };
globalThis.fetch = async (url) => {
  if (String(url).includes('/auth/v1/user')) {
    return new Response(JSON.stringify(supabaseUser), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  throw new Error('unexpected fetch in test: ' + url);
};

function makeVideos(opts = {}) {
  const store = new Map();      // key -> { bytes, contentType }
  const uploads = new Map();    // uploadId -> { key, parts }
  let seq = 0;
  const handle = (uploadId, key) => ({
    uploadId, key,
    async uploadPart(n, body) {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      const u = uploads.get(uploadId);
      if (!u) throw new Error('No such multipart upload');
      u.parts.set(n, bytes);
      return { partNumber: n, etag: 'etag-' + n };
    },
    async complete(parts) {
      const u = uploads.get(uploadId);
      if (!u) throw new Error('No such multipart upload');
      const ordered = parts.slice().sort((a, b) => a.partNumber - b.partNumber);
      const bufs = ordered.map(p => {
        const b = u.parts.get(p.partNumber);
        if (!b) throw new Error('missing part ' + p.partNumber);
        return b;
      });
      if (!bufs.length) throw new Error('no parts');
      const all = Buffer.concat(bufs.map(Buffer.from));
      const shrink = opts.shrinkOnComplete ? Math.floor(all.length * 0.5) : all.length;
      store.set(key, { bytes: all.subarray(0, shrink), contentType: u.contentType });
      uploads.delete(uploadId);
      return { size: shrink, key };
    },
    async abort() { uploads.delete(uploadId); },
  });
  return {
    store, uploads,
    async createMultipartUpload(key, o) {
      const uploadId = 'up-' + (++seq);
      uploads.set(uploadId, { key, parts: new Map(), contentType: o?.httpMetadata?.contentType });
      return handle(uploadId, key);
    },
    resumeMultipartUpload(key, uploadId) {
      if (!uploads.has(uploadId)) throw new Error('No such multipart upload: ' + uploadId);
      return handle(uploadId, key);
    },
    async put(key, body, o) {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      const shrink = opts.shrinkOnPut ? Math.floor(bytes.length * 0.5) : bytes.length;
      store.set(key, { bytes: bytes.subarray(0, shrink), contentType: o?.httpMetadata?.contentType });
      return { key };
    },
    async head(key) { const o = store.get(key); return o ? { size: o.bytes.length, key } : null; },
    async delete(key) { store.delete(key); return true; },
  };
}

const envFor = (videos) => ({
  VIDEOS: videos,
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
  R2_PUBLIC_URL: 'https://pub-test.r2.dev',
});

async function call(env, method, url, { body, json, token = 'good-token', headers: extra = {} } = {}) {
  const headers = Object.assign({}, extra);
  if (token) headers.authorization = 'Bearer ' + token;
  let payload;
  if (json !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(json); }
  else if (body !== undefined) { headers['content-type'] = 'application/octet-stream'; payload = body; }
  const req = new Request('https://loveflix.us' + url, { method, headers, body: payload });
  const res = await mod.onRequest({ request: req, env, waitUntil: () => {} });
  const text = await res.text();
  let parsed = null; try { parsed = JSON.parse(text); } catch {}
  return { status: res.status, body: parsed, text };
}

console.log('\n— server: chunked upload round trip (real handler, stub R2) —');
const videos = makeVideos();
const env = envFor(videos);
const payload = crypto.randomBytes(5 * 1024 * 1024 + 12345);   // 5 MB + tail, 3 parts at 2 MB
const PART = 2 * 1024 * 1024;

const created = await call(env, 'POST', '/api/upload-multipart/create',
  { json: { filename: 'Screen Recording 2026.mov', contentType: '', folder: 'videos' } });
check('create -> 200', created.status, 200);
check('create returns an uploadId', typeof created.body?.uploadId === 'string' && created.body.uploadId.length > 0, true);
check('create keys the object under the caller (no cross-user writes)',
  created.body?.key?.startsWith(`videos/${USER_ID}/`), true);
check('.mov with no browser type stored as video/quicktime', created.body?.content_type, 'video/quicktime');
check('create returns a public url', String(created.body?.public_url || '').startsWith('https://pub-test.r2.dev/videos/'), true);

const key = created.body.key, uploadId = created.body.uploadId;
const parts = [];
for (let off = 0, n = 1; off < payload.length; off += PART, n++) {
  const chunk = payload.subarray(off, Math.min(payload.length, off + PART));
  const r = await call(env, 'PUT',
    `/api/upload-multipart/part?key=${encodeURIComponent(key)}&uploadId=${encodeURIComponent(uploadId)}` +
    `&partNumber=${n}&bytes=${chunk.length}`,
    { body: chunk });
  check(`part ${n} accepted (${chunk.length} bytes)`, r.status, 200);
  parts.push({ partNumber: r.body.partNumber, etag: r.body.etag });
}
check('3 parts uploaded', parts.length, Math.ceil(payload.length / PART));

const done = await call(env, 'POST', '/api/upload-multipart/complete',
  { json: { key, uploadId, parts, size: payload.length } });
check('complete -> 200', done.status, 200);
check('complete reports the declared size', done.body?.size, payload.length);

const storedBuf = Buffer.from(videos.store.get(key).bytes);
check('reassembled bytes are byte-identical to the original file',
  crypto.createHash('sha256').update(storedBuf).digest('hex'),
  crypto.createHash('sha256').update(payload).digest('hex'));
check('nothing was cut (stored length == sent length)', storedBuf.length, payload.length);

console.log('\n— server: never report success on a short file —');
{
  const v = makeVideos({ shrinkOnComplete: true });
  const ev = envFor(v);
  const c = await call(ev, 'POST', '/api/upload-multipart/create', { json: { filename: 'a.mov' } });
  const r1 = await call(ev, 'PUT', `/api/upload-multipart/part?key=${encodeURIComponent(c.body.key)}&uploadId=${c.body.uploadId}&partNumber=1`, { body: Buffer.alloc(64, 7) });
  const d = await call(ev, 'POST', '/api/upload-multipart/complete',
    { json: { key: c.body.key, uploadId: c.body.uploadId, parts: [{ partNumber: r1.body.partNumber, etag: r1.body.etag }], size: 64 } });
  check('short stored file -> 400', d.status, 400);
  check('short stored file -> size_mismatch', d.body?.error, 'size_mismatch');
  check('short stored file -> never says ok', d.body?.ok, undefined);
}
{
  // A one-shot PUT that lands short because the connection was cut at Cloudflare's
  // request cap: the browser sends Content-Length, so the server can catch it.
  const v = makeVideos({ shrinkOnPut: true });
  const ev = envFor(v);
  const k = `videos/${USER_ID}/big.mov`;
  const r = await call(ev, 'PUT', `/api/upload-object?key=${encodeURIComponent(k)}`,
    { body: Buffer.alloc(1000, 1), headers: { 'content-length': '1000' } });
  check('one-shot PUT with Content-Length that lands short -> 400', r.status, 400);
  check('...reports upload_truncated', r.body?.error, 'upload_truncated');
  check('...deletes the partial object', v.store.has(k), false);

  // Same detection through the explicit `bytes` declaration (no Content-Length).
  const v2 = makeVideos({ shrinkOnPut: true });
  const ev2 = envFor(v2);
  const r2 = await call(ev2, 'PUT', `/api/upload-object?key=${encodeURIComponent(k)}&bytes=1000`,
    { body: Buffer.alloc(1000, 1) });
  check('one-shot PUT declaring bytes= that lands short -> 400', r2.status, 400);
  check('...reports upload_truncated', r2.body?.error, 'upload_truncated');

  // And a whole file must NOT be flagged (no false positives).
  const v3 = makeVideos();
  const ev3 = envFor(v3);
  const r3 = await call(ev3, 'PUT', `/api/upload-object?key=${encodeURIComponent(k)}&bytes=1000`,
    { body: Buffer.alloc(1000, 1) });
  check('one-shot PUT that lands whole -> 200 ok', r3.status, 200);
  check('...file is kept', v3.store.get(k)?.bytes?.length, 1000);
}

console.log('\n— server: auth + key scoping —');
{
  const ev = envFor(makeVideos());
  const u = await call(ev, 'POST', '/api/upload-multipart/create', { json: { filename: 'a.mov' }, token: null });
  check('unauthenticated create -> 401', u.status, 401);
  const f = await call(ev, 'PUT', `/api/upload-multipart/part?key=${encodeURIComponent('videos/someone-else/x.mov')}&uploadId=up-1&partNumber=1`, { body: Buffer.alloc(8) });
  check('part upload to another user\'s key -> 403', f.status, 403);
  const fc = await call(ev, 'POST', '/api/upload-multipart/complete', { json: { key: 'videos/someone-else/x.mov', uploadId: 'up-1', parts: [{ partNumber: 1, etag: 'e' }] } });
  check('complete on another user\'s key -> 403', fc.status, 403);
  const bad = await call(ev, 'POST', '/api/upload-multipart/complete', { json: { key: `videos/${USER_ID}/x.mov`, uploadId: 'up-1', parts: [] } });
  check('complete with no parts -> 400', bad.status, 400);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
