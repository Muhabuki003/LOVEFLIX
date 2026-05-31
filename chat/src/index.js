// LoveFlix Chat Worker — couple-scoped messaging
// Auth: validates Supabase JWT (same token as the main LoveFlix app)
// Rooms: one Durable Object per couple (room_id = couple_id UUID)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });

const uid = () => crypto.randomUUID();
const now = () => Date.now();

// Validate a Supabase JWT by calling /auth/v1/user.
// WebSocket connections can't set headers, so also accept ?token= query param.
async function authUser(request, env) {
  const url = new URL(request.url);
  const header = request.headers.get("Authorization") || "";
  const t = (header.startsWith("Bearer ") ? header.slice(7) : null)
    || url.searchParams.get("token");
  if (!t) return null;

  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${t}`, apikey: env.SUPABASE_ANON_KEY },
  });
  if (!res.ok) return null;
  const user = await res.json();
  if (!user?.id) return null;
  return { userId: user.id, email: user.email, _token: t };
}

// Fetch this user's couple membership + partner in one call.
//
// Names are resolved by the SECURITY DEFINER RPC `get_couple_roster`, which
// prefers couple_members.display_name, then auth metadata, then the email
// local-part. couple_members.display_name alone is frequently null (e.g. the
// admin/billing-owner rows), which is why a plain column select left names
// blank. The RPC is scoped to the caller's couple via auth.uid().
async function getMembership(userId, token, env) {
  let roster = null;
  try {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/get_couple_roster`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: env.SUPABASE_ANON_KEY,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    if (res.ok) roster = await res.json();
  } catch (_) {
    roster = null;
  }
  if (!Array.isArray(roster) || roster.length === 0) return null;

  const me = roster.find(r => r.is_self) || roster.find(r => r.user_id === userId);
  if (!me) return null;
  const partnerRow = roster.find(r => r.user_id !== userId) || null;

  return {
    coupleId: me.couple_id,
    displayName: me.display_name,
    role: me.role,
    partner: partnerRow
      ? { user_id: partnerRow.user_id, display_name: partnerRow.display_name, role: partnerRow.role }
      : null,
  };
}

// ---------- Worker entrypoint ----------
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Every route requires a valid Supabase session + couple membership.
      const me = await authUser(request, env);
      if (!me) return json({ error: "unauthorized" }, 401);

      const membership = await getMembership(me.userId, me._token, env);
      if (!membership) {
        return json({ error: "couple not found — complete your LoveFlix setup first" }, 403);
      }

      const { coupleId, displayName: myName } = membership;

      // GET /api/me — current user + partner info for the UI header
      if (path === "/api/me" && request.method === "GET") {
        const partner = membership.partner;
        return json({
          me: { id: me.userId, displayName: myName, coupleId },
          partner: partner
            ? { id: partner.user_id, displayName: partner.display_name }
            : null,
        });
      }

      // GET /api/history — paginated message history for the couple
      if (path === "/api/history" && request.method === "GET") {
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "100", 10), 200);
        const { results } = await env.DB.prepare(
          `SELECT id, sender_id, sender_name, text, created_at
           FROM couple_messages WHERE room_id = ?
           ORDER BY created_at ASC LIMIT ?`
        ).bind(coupleId, limit).all();
        return json({ roomId: coupleId, messages: results || [] });
      }

      // POST /api/send — persist message + broadcast to Durable Object
      if (path === "/api/send" && request.method === "POST") {
        const body = await request.json();
        const text = body?.text?.trim();
        if (!text) return json({ error: "text required" }, 400);

        // Ensure a room record exists for this couple
        await env.DB.prepare(
          "INSERT OR IGNORE INTO couple_rooms (id, created_at) VALUES (?,?)"
        ).bind(coupleId, now()).run();

        const msg = {
          id: uid(),
          room_id: coupleId,
          sender_id: me.userId,
          sender_name: myName || me.email,
          text,
          created_at: now(),
        };
        await env.DB.prepare(
          `INSERT INTO couple_messages (id, room_id, sender_id, sender_name, text, created_at)
           VALUES (?,?,?,?,?,?)`
        ).bind(msg.id, msg.room_id, msg.sender_id, msg.sender_name, msg.text, msg.created_at).run();

        // Broadcast to the Durable Object (which fans out to all WS sessions)
        const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(coupleId));
        await stub.fetch("https://do/broadcast", {
          method: "POST",
          body: JSON.stringify({ type: "message", ...msg }),
        });

        return json({ ok: true, message: msg });
      }

      // POST /api/typing — ephemeral typing indicator (not persisted)
      if (path === "/api/typing" && request.method === "POST") {
        const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(coupleId));
        await stub.fetch("https://do/broadcast", {
          method: "POST",
          body: JSON.stringify({ type: "typing", sender_id: me.userId, sender_name: myName }),
        });
        return json({ ok: true });
      }

      // GET /api/connect — WebSocket upgrade, proxied through Durable Object
      if (path === "/api/connect") {
        const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(coupleId));
        return stub.fetch(request);
      }

      return json({ error: "not found" }, 404);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },
};

// ---------- Durable Object: one instance per couple ----------
export class ChatRoom {
  constructor(state) {
    this.state = state;
    this.sessions = new Set();
  }

  async fetch(request) {
    const url = new URL(request.url);

    // Internal broadcast from the Worker after a message is saved
    if (url.pathname === "/broadcast") {
      const msg = await request.json();
      this.broadcast(JSON.stringify(msg));
      return new Response("ok");
    }

    // WebSocket upgrade
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      this.sessions.add(server);
      server.addEventListener("close", () => this.sessions.delete(server));
      server.addEventListener("error", () => this.sessions.delete(server));
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("expected websocket", { status: 400 });
  }

  broadcast(data) {
    for (const ws of this.sessions) {
      try { ws.send(data); } catch { this.sessions.delete(ws); }
    }
  }
}
