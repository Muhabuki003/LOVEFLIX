# LoveFlix Bug Audit — June 9, 2026

**Repo:** `github.com/Muhabuki003/LOVEFLIX` (main)
**Live:** https://loveflix-eac.pages.dev

---

## ✅ FIXED (in main — merged & pushed)

| Issue | Commit | Status |
|-------|--------|--------|
| Messages showing emails instead of display names | `5c31599` | ✅ Fixed |
| Hardcoded Supabase keys in main files | `e43ab99` | ✅ Fixed |
| Dead `href="#"` links (footer, nav) | `e43ab99` | ✅ Fixed |
| Stripe placeholder key fallback | `e43ab99` | ✅ Fixed |
| Missing pages built (privacy, terms, etc.) | `b448f25` | ✅ Fixed |
| Dead email invite button (issue 3) | `008a8bb` | ✅ Fixed |
| Footer cleanup + accessibility page (issue 4) | `008a8bb` | ✅ Fixed |
| Dynamic pricing fetch from Stripe (issue 5) | `99ace49` | ✅ Fixed |
| SoundCloud → YouTube API migration (issue 6) | `99ace49` | ✅ Fixed |
| Live notification WebSocket across all pages | `848ffb8` | ✅ Fixed |
| Polling fallback for silent WS failures | `7ffd323` | ✅ Fixed |
| Fullscreen notification queueing | `a05936e` | ✅ Fixed |
| Couple name sync across all pages | `04328ff` | ✅ Fixed |
| Anniversary live-update | `54ca7f2` | ✅ Fixed |
| LoveConnect globe/map + flights | `134c12a`, `9f1c980` | ✅ Fixed |
| Video editor rebranded (no OpenReel) | Multiple | ✅ Fixed |
| RLS policies on all Supabase tables | `72bc910` | ✅ Fixed |
| API security audit (rate limiting, CORS) | `5db0c02` | ✅ Fixed |
| Passcode gate per-user (not hardcoded) | In branch | ✅ Fixed |
| Waitlist D1-backed signup counter | `0bc31c7` | ✅ Fixed |
| Mobile layout fixes (bento, chat) | `678c3c6` | ✅ Fixed |

---

## ❌ STILL OPEN

### 🔐 Security Issues

| # | Issue | File(s) | Severity |
|---|-------|---------|----------|
| 1 | **Gate password `mukstudio2026` hardcoded in 26 HTML files** | All pages with `<!-- LF_GATE_START -->` blocks | **HIGH** — anyone can view source and see it |
| 2 | **Supabase anon key hardcoded in waitlist.html** | `waitlist.html:444-445` — `SUPABASE_URL` + `SUPABASE_ANON_KEY` exposed | **MEDIUM** — anon key is publishable but shouldn't be in multiple places |
| 3 | **loveflix.js still uses local SUPA vars, not LoveFlix global** | `assets/loveflix.js:4-5` — should reference `LoveFlix.SUPABASE_URL` / `LoveFlix.SUPABASE_ANON_KEY` | **LOW** — exposed at bottom anyway (l.1077-1078) |

### 🕳️ Empty / Dead Pages

| # | Issue | File | Severity |
|---|-------|------|----------|
| 4 | **our-story-map.html is 0 bytes** — empty page, dead end | `our-story-map.html` | **MEDIUM** — nav link points here somewhere |

### 🔗 Dead Links

| # | Issue | Location | Severity |
|---|-------|----------|----------|
| 5 | `href="#"` — Creator sidebar Videos tab | `creator.html:159` | **LOW** — tab works via JS |
| 6 | `href="#"` — Creator sidebar Analytics tab | `creator.html:163` | **LOW** — tab works via JS |
| 7 | `href="#"` — Bulk edit (admin feature stub) | `admin_videos.html:194` | **LOW** — not designed yet |
| 8 | `href="#"` — Export CSV (admin feature stub) | `admin_videos.html:194` | **LOW** — not designed yet |
| 9 | `href="#"` — Landing page logo | `landing.html:118` | **LOW** — cosmetic |

### 🚧 "Coming Soon" Placeholders

| # | Issue | Location | Severity |
|---|-------|----------|----------|
| 10 | "Analytics coming soon" | `creator.html:330` | **LOW** — creator feature |
| 11 | "Call scheduling is coming soon" | `loveconnect.html:854` | **LOW** — future feature |
| 12 | "Trip distance tracking is coming soon" | `loveconnect.html:946` | **LOW** — future feature |
| 13 | "Radio stations coming soon!" toast | `music.html:1269` | **LOW** — future feature |
| 14 | "Video coming soon 💕" placeholder | `player.html:577` | **LOW** — edge case message |

### 📊 Production Cleanup

| # | Issue | Location | Severity |
|---|-------|----------|----------|
| 15 | `console.log` in production — LoveFlix Music loaded | `music.html:1352` | **LOW** — debug log |
| 16 | `console.log` in API — request logging | `functions/api/[[path]].js:211` | **LOW** — server-side log |

### 🧹 Other

| # | Issue | Location | Severity |
|---|-------|----------|----------|
| 17 | **Stray file: `waitlist.html` — not in repo root** | `waitlist.html` exists at root but LoveFlix uses `_redirects` rule to serve it at `https://root` | **LOW** |
| 18 | **Capacitor build artifact drift** — `www/index.html` may have stale links | `www/index.html` | **LOW** — generated file, check periodically |

---

## Summary

| Category | Count | Status |
|----------|-------|--------|
| ✅ Fixed (merged to main) | ~21 issues | 🟢 |
| 🔴 High severity open | 1 (gate password) | Needs architecture change |
| 🟡 Medium severity open | 2 (empty page, hardcoded keys in waitlist) | Quick fixes |
| 🟢 Low severity open | 15 (placeholder text, dead tabs, debug logs) | Polish |
