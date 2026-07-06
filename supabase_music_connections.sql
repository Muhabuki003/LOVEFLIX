-- ─────────────────────────────────────────────────────────────────────────────
-- LoveFlix Music — Tri-provider connectors (Spotify / Apple Music / YouTube)
--
-- music_connections: one row per provider link, per account.
--   * provider: 'spotify' | 'apple_music' | 'youtube'
--   * Spotify stores access/refresh tokens; Apple Music stores the MusicKit
--     Music User Token; YouTube needs NO tokens (free tier, no account link —
--     the row just marks the user's active provider choice).
--   * At most ONE active provider per user (partial unique index). Switching
--     providers soft-deletes the old row (disconnected_at) so reconnect
--     history is preserved.
--
-- couple_music_state: provider-agnostic "listen together" state. Tracks are
-- stored as title/artist/ISRC — never provider-specific IDs — so each partner
-- resolves the track on WHATEVER provider they are connected to (Spotify or
-- Apple Music by ISRC, YouTube by "{artist} {title} official audio" search).
--
-- RLS is mandatory (LOVEFLIX project rule):
--   * music_connections rows (which contain OAuth tokens) are readable and
--     writable by their owner ONLY. A partner never sees the other's tokens —
--     partner provider discovery goes through the token-free
--     get_partner_music_provider() RPC below.
--   * couple_music_state is readable/writable by members of that couple,
--     verified via couple_members (existing project pattern).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.music_connections (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 uuid NOT NULL,
  provider                text NOT NULL CHECK (provider IN ('spotify','apple_music','youtube')),
  access_token            text,          -- Spotify OAuth access token
  refresh_token           text,          -- Spotify OAuth refresh token
  music_user_token        text,          -- Apple Music (MusicKit) user token
  token_expires_at        timestamptz,   -- Spotify access token expiry
  provider_account_email  text,          -- shown in the connectors UI
  provider_account_name   text,          -- shown in the connectors UI
  is_premium              boolean,       -- Spotify: product === 'premium'; Apple: active subscription
  connected_at            timestamptz NOT NULL DEFAULT now(),
  disconnected_at         timestamptz    -- soft delete: set when switching/disconnecting
);

-- Users can have at most one ACTIVE provider at a time.
CREATE UNIQUE INDEX IF NOT EXISTS music_connections_one_active_per_user
  ON public.music_connections (user_id)
  WHERE disconnected_at IS NULL;

CREATE INDEX IF NOT EXISTS music_connections_user_history
  ON public.music_connections (user_id, connected_at DESC);

ALTER TABLE public.music_connections ENABLE ROW LEVEL SECURITY;

-- Owner-only access: tokens must never leak to the partner (or anyone else).
CREATE POLICY "own music connections select"
  ON public.music_connections
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "own music connections insert"
  ON public.music_connections
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "own music connections update"
  ON public.music_connections
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- No DELETE policy: disconnect/switch is a soft delete (disconnected_at),
-- keeping reconnect history per the connectors spec.

-- Partner provider discovery WITHOUT exposing tokens. SECURITY DEFINER so it
-- can read the partner's row, but it only returns token-free display fields.
CREATE OR REPLACE FUNCTION public.get_partner_music_provider()
RETURNS TABLE (provider text, provider_account_name text, is_premium boolean, connected_at timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT mc.provider, mc.provider_account_name, mc.is_premium, mc.connected_at
  FROM public.music_connections mc
  JOIN public.couple_members partner ON partner.user_id = mc.user_id
  JOIN public.couple_members me
    ON me.couple_id = partner.couple_id
   AND me.user_id = auth.uid()
  WHERE partner.user_id <> auth.uid()
    AND mc.disconnected_at IS NULL
  ORDER BY mc.connected_at DESC
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_partner_music_provider() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_partner_music_provider() TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Shared playback state ("listen together"), provider-agnostic.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.couple_music_state (
  couple_id         uuid PRIMARY KEY,
  track_title       text,
  track_artist      text,
  track_isrc        text,          -- canonical cross-provider match key (when known)
  track_artwork_url text,
  source_provider   text CHECK (source_provider IN ('spotify','apple_music','youtube')),
  source_track_ref  text,          -- provider-native id from the sender (hint only, never required)
  is_playing        boolean NOT NULL DEFAULT false,
  position_seconds  numeric NOT NULL DEFAULT 0,
  duration_seconds  numeric,
  updated_by        uuid,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.couple_music_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "couple music state select"
  ON public.couple_music_state
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.couple_members m
      WHERE m.couple_id = couple_music_state.couple_id
        AND m.user_id = auth.uid()
    )
  );

CREATE POLICY "couple music state insert"
  ON public.couple_music_state
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.couple_members m
      WHERE m.couple_id = couple_music_state.couple_id
        AND m.user_id = auth.uid()
    )
  );

CREATE POLICY "couple music state update"
  ON public.couple_music_state
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.couple_members m
      WHERE m.couple_id = couple_music_state.couple_id
        AND m.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.couple_members m
      WHERE m.couple_id = couple_music_state.couple_id
        AND m.user_id = auth.uid()
    )
  );
