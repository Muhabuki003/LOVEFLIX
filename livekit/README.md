# Self-hosted LiveKit (video calling)

Runs the LiveKit SFU behind Caddy (automatic TLS) for LOVEFLIX video calls.
The browser client gets `{ token, url }` from `POST /api/livekit-token`
(Cloudflare Pages function) and opens a WebSocket to `url` — if this stack
isn't reachable, calls fail with *"encountered websocket error while
establishing connection"*.

## Setup

1. Point DNS for your call domain (e.g. `call.loveflix.so`) at this server.
2. `cp .env.example .env` and fill in `DOMAIN` plus a fresh API key pair
   (`docker run --rm livekit/livekit-server generate-keys`).
3. Open firewall ports: **80/tcp, 443/tcp+udp** (Caddy), **7881/tcp**
   (WebRTC TCP fallback), **50000–50100/udp** (WebRTC media).
4. `docker compose up -d`
5. Set the matching Cloudflare Pages secrets:

   ```
   wrangler pages secret put LIVEKIT_API_KEY
   wrangler pages secret put LIVEKIT_API_SECRET
   wrangler pages secret put LIVEKIT_URL        # wss://<DOMAIN>
   ```

## Verify

```
# From anywhere — should print a LiveKit version banner (HTTP 200):
curl https://<DOMAIN>/

# Signal endpoint — an HTTP 401 here is GOOD (server up, token required);
# a connection error / 502 means Caddy can't reach livekit-server:
curl -i "https://<DOMAIN>/rtc/validate?access_token=x"
```

Then call from two browsers; `docker compose logs -f livekit-server` shows
room joins.

## Troubleshooting the WebSocket error

- **502 / connection refused on wss://<DOMAIN>** — Caddy and livekit-server
  must run in the same compose project (the Caddyfile targets the
  `livekit-server` service name). `docker compose ps` should list all three
  services.
- **Token endpoint returns 503 `livekit_not_configured`** — the three
  Cloudflare secrets above aren't set for the Pages project.
- **Call connects but no audio/video** — UDP 50000–50100 blocked, or
  `node_ip` was set in `livekit.yaml` (it must not be; `use_external_ip`
  handles public-IP discovery).
- **401 on connect** — key pair in `.env` doesn't match the Cloudflare
  secrets.
