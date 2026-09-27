/**
 * MP4 + MOV upload acceptance — regression test.
 *
 * Slices the REAL code out of both files (marker-fenced blocks) rather than
 * testing a copy, the same way the other LoveFlix harnesses work:
 *   - functions/api/[[path]].js   ── lf-upload-mime-start / -end ──
 *   - admin_upload.html           ── lf-video-type-start / -end ──
 *
 * Run: node tests/video-mime.test.mjs   (also wired into `npm test`)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;

function check(name, actual, expected) {
  const ok = actual === expected;
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        expected ${expected}\n        actual   ${actual}`}`);
}

function sliceBetween(src, startTag, endTag) {
  const s = src.indexOf(startTag);
  const e = src.indexOf(endTag);
  if (s < 0 || e < 0) throw new Error(`markers not found: ${startTag} / ${endTag}`);
  const after = src.indexOf('\n', s) + 1;
  const before = src.lastIndexOf('\n', e);
  return src.slice(after, before);
}

// ---------------------------------------------------------------- server side
const serverSrc = readFileSync(join(root, 'functions/api/[[path]].js'), 'utf8');
const serverBlock = sliceBetween(serverSrc, 'lf-upload-mime-start', 'lf-upload-mime-end');
const lfUploadContentType = new Function(`${serverBlock}\nreturn lfUploadContentType;`)();

console.log('— server: lfUploadContentType(filename, providedType, folder) —');
check('.mov with no type      -> video/quicktime', lfUploadContentType('trip.mov', '', 'videos'), 'video/quicktime');
check('.MOV uppercase         -> video/quicktime', lfUploadContentType('TRIP.MOV', undefined, 'videos'), 'video/quicktime');
check('.qt                    -> video/quicktime', lfUploadContentType('trip.qt', null, 'videos'), 'video/quicktime');
check('.mp4 with no type      -> video/mp4', lfUploadContentType('trip.mp4', '', 'videos'), 'video/mp4');
check('.m4v                   -> video/mp4', lfUploadContentType('trip.m4v', '', 'videos'), 'video/mp4');
check('.mov claiming mp4      -> video/quicktime (extension wins over octet-stream)', lfUploadContentType('trip.mov', 'application/octet-stream', 'videos'), 'video/quicktime');
check('explicit quicktime wins', lfUploadContentType('trip.mp4', 'video/quicktime', 'videos'), 'video/quicktime');
check('explicit mp4 wins      ', lfUploadContentType('trip.mov', 'video/mp4', 'videos'), 'video/mp4');
check('video/* wildcard is inferred, not trusted', lfUploadContentType('trip.mov', 'video/*', 'videos'), 'video/quicktime');
check('.mkv                   -> video/x-matroska', lfUploadContentType('trip.mkv', '', 'videos'), 'video/x-matroska');
check('.webm                  -> video/webm', lfUploadContentType('trip.webm', '', 'videos'), 'video/webm');
check('unknown ext, videos    -> video/mp4', lfUploadContentType('mystery', '', 'videos'), 'video/mp4');
check('jpg in images folder   -> image/jpeg', lfUploadContentType('us.jpg', '', 'images'), 'image/jpeg');
check('.HEIC in images folder -> image/heic', lfUploadContentType('us.HEIC', undefined, 'images'), 'image/heic');
check('unknown ext, images    -> image/jpeg', lfUploadContentType('mystery', '', 'images'), 'image/jpeg');
check('explicit image type kept', lfUploadContentType('us.png', 'image/png', 'images'), 'image/png');

// every upload path must use the helper: 1 definition + getUploadUrl +
// presignVideoUpload + multipartCreate
const callSites = (serverSrc.match(/lfUploadContentType\(/g) || []).length;
check('helper used by every upload path (def + 3 calls)', callSites, 4);

// ---------------------------------------------------------------- client side
const htmlSrc = readFileSync(join(root, 'admin_upload.html'), 'utf8');
const htmlBlock = sliceBetween(htmlSrc, 'lf-video-type-start', 'lf-video-type-end');
const { lfVideoContentType, lfIsVideoFile } = new Function(
  `${htmlBlock}\nreturn { lfVideoContentType, lfIsVideoFile };`)();

const f = (name, type) => ({ name, type });

console.log('\n— admin_upload.html: picker + validation —');
check('.mov, empty type: accepted', lfIsVideoFile(f('trip.mov', '')), true);
check('.mov, empty type: content type video/quicktime', lfVideoContentType(f('a.mov', '')), 'video/quicktime');
check('.MOV from iPhone: accepted', lfIsVideoFile(f('IMG_0142.MOV', '')), true);
check('.mp4: accepted', lfIsVideoFile(f('trip.mp4', 'video/mp4')), true);
check('.mp4 empty type: video/mp4', lfVideoContentType(f('trip.mp4', '')), 'video/mp4');
check('.mkv with octet-stream: accepted', lfIsVideoFile(f('trip.mkv', 'application/octet-stream')), true);
check('.mkv with octet-stream: video/x-matroska', lfVideoContentType(f('trip.mkv', 'application/octet-stream')), 'video/x-matroska');
check('quicktime mime: accepted', lfIsVideoFile(f('noext', 'video/quicktime')), true);
check('a .txt is rejected', lfIsVideoFile(f('notes.txt', 'text/plain')), false);
check('an image is rejected', lfIsVideoFile(f('us.jpg', 'image/jpeg')), false);
check('no file names: rejected', lfIsVideoFile({}), false);

// the picker must name MOV explicitly or Android/iOS pickers grey it out
const accept = (htmlSrc.match(/id="fileInput"[^>]*accept="([^"]+)"/) || [])[1] || '';
check('file input accept lists MOV mime', accept.includes('video/quicktime'), true);
check('file input accept lists .mov extension', accept.includes('.mov'), true);
check('file input accept still lists MP4', accept.includes('video/mp4') && accept.includes('.mp4'), true);
// no path may hardcode a video/mp4 fallback that could clobber a MOV
check('no raw file.type || video/mp4 fallback left', /file\.type\s*\|\|\s*'video\/mp4'/.test(htmlSrc), false);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
