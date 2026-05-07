# LoveFlix

A private Netflix-style streaming service for two. Vanilla JS + HTML, deployed on Cloudflare Pages with D1 (database), R2 (video storage), Pages Functions (API), and Supabase (auth only).

## Stack

- **Hosting:** Cloudflare Pages (static HTML + Pages Functions)
- **Database:** Cloudflare D1
- **Storage:** Cloudflare R2 (`loveflix-videos`)
- **API:** Cloudflare Pages Functions (`/functions/api/[[path]].js`)
- **Auth:** Supabase (login + JWT only)

## Project layout

```
.
├── wrangler.toml                  # Cloudflare config (D1 + R2 bindings)
├── schema.sql                     # D1 schema
├── functions/
│   └── api/
│       └── [[path]].js            # Catch-all API for /api/*
├── assets/
│   └── loveflix.js                # Shared client: auth + API + uploader
├── loveflix_login_screen.html     # Supabase sign-in
├── home.html                      # Fetches videos from /api/videos
├── player.html                    # Real <video> player, saves progress every 5s
├── admin_upload.html              # Direct-to-R2 upload via presigned URL
├── admin_videos.html / admin*.html
└── ...
```

## One-time setup

### 1. Install Wrangler and log in

```bash
npm install -g wrangler
wrangler login
```

### 2. Create the D1 database

```bash
wrangler d1 create loveflix-db
```

Copy the printed `database_id` and paste it into `wrangler.toml` (replace `REPLACE_WITH_D1_ID_AFTER_CREATE`).

### 3. Apply the schema

```bash
# Local (for dev with `wrangler pages dev`)
wrangler d1 execute loveflix-db --file=./schema.sql --local

# Remote (production)
wrangler d1 execute loveflix-db --file=./schema.sql --remote
```

### 4. Create the R2 bucket

```bash
wrangler r2 bucket create loveflix-videos
```

### 5. Make videos publicly readable

The browser plays videos directly from R2, so the bucket needs public reads. Either:

- **Easiest:** in the Cloudflare dashboard → R2 → `loveflix-videos` → Settings, enable **Public R2.dev URL**, then copy that URL into `wrangler.toml` as `R2_PUBLIC_URL` (e.g. `https://pub-XXXX.r2.dev`).
- **Production:** attach a custom domain (e.g. `media.loveflix.app`) and set `R2_PUBLIC_URL` to that.

### 6. Generate R2 S3-API tokens (for presigned uploads)

In the dashboard → R2 → **Manage R2 API Tokens** → **Create API Token** → permissions `Object Read & Write` for `loveflix-videos`. Copy the **Access Key ID** and **Secret Access Key**, then store them as Pages secrets:

```bash
wrangler pages secret put R2_ACCESS_KEY_ID --project-name loveflix
wrangler pages secret put R2_SECRET_ACCESS_KEY --project-name loveflix
```

### 7. Configure CORS on the bucket

Browsers do PUTs straight to R2 from `admin_upload.html`. R2 needs to allow it.

Save this as `cors.json`:

```json
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

Apply it:

```bash
wrangler r2 bucket cors put loveflix-videos --rules ./cors.json
```

(For production, narrow `AllowedOrigins` to your domain.)

## Deploy

### First-time

```bash
wrangler pages project create loveflix --production-branch main
wrangler pages deploy . --project-name loveflix
```

### Subsequent deploys

```bash
wrangler pages deploy . --project-name loveflix
```

Pages auto-discovers `functions/api/[[path]].js` and routes `/api/*` through it.

## Local dev

```bash
wrangler pages dev . --d1=DB=loveflix-db --r2=VIDEOS=loveflix-videos
```

Then open http://localhost:8788.

> Tip: the upload-URL endpoint requires the R2 access keys. Set them locally with a `.dev.vars` file:
>
> ```
> R2_ACCESS_KEY_ID=...
> R2_SECRET_ACCESS_KEY=...
> ```

## API surface

| Method  | Path                  | Auth | Notes                                            |
| ------- | --------------------- | ---- | ------------------------------------------------ |
| GET     | `/api/health`         | —    |                                                  |
| GET     | `/api/videos`         | opt. | Lists published videos for the tenant.           |
| GET     | `/api/videos/:id`     | ✅    | Fetch a single video.                            |
| POST    | `/api/videos`         | ✅    | Create video metadata after R2 upload completes. |
| DELETE  | `/api/videos/:id`     | ✅    | Removes the row + R2 object.                     |
| GET     | `/api/upload-url`     | ✅    | Returns a presigned PUT URL for R2.              |
| GET     | `/api/progress`       | ✅    | Returns the user's watch progress rows.          |
| POST    | `/api/progress`       | ✅    | Saves `{ video_id, progress_seconds, completed }`. |

The Worker validates Supabase JWTs by hitting `${SUPABASE_URL}/auth/v1/user` — no extra secrets needed beyond the anon key already in `wrangler.toml`.

## Auth flow

1. User signs in on `loveflix_login_screen.html` — `assets/loveflix.js` calls `${SUPABASE_URL}/auth/v1/token?grant_type=password`.
2. The returned `access_token` is stored in `localStorage` as `loveflix_token`.
3. Every API request sends `Authorization: Bearer <token>`.
4. `LoveFlix.requireAuth()` redirects to the login screen if the token is missing.
5. `loveflix.js` clears the token and redirects on any 401.

## Failure-safe video playback

`player.html` shows a clean black + LoveFlix logo + "Video coming soon 💕" placeholder when:

- The URL param has no `id` and there are no videos yet, **or**
- The selected video has no `video_url`, **or**
- The `<video>` element fires an `error` event (bad file, CORS, 404, etc.).

Controls and metadata stay rendered — there is no broken-player chrome.
