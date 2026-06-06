-- RLS policies for couple music/playlist tables.
-- Apply after supabase_waitlist.sql.
-- Run in Supabase → SQL Editor, or via apply_migration.

ALTER TABLE public.couple_playlists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.couple_playlist_songs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.couple_music_plays ENABLE ROW LEVEL SECURITY;

-- ── couple_playlists ─────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "couple members can view playlists" ON public.couple_playlists;
CREATE POLICY "couple members can view playlists"
  ON public.couple_playlists
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM couple_members m
      WHERE m.couple_id = couple_playlists.couple_id
        AND m.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "couple members can insert playlists" ON public.couple_playlists;
CREATE POLICY "couple members can insert playlists"
  ON public.couple_playlists
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM couple_members m
      WHERE m.couple_id = couple_playlists.couple_id
        AND m.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "couple members can update playlists" ON public.couple_playlists;
CREATE POLICY "couple members can update playlists"
  ON public.couple_playlists
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM couple_members m
      WHERE m.couple_id = couple_playlists.couple_id
        AND m.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM couple_members m
      WHERE m.couple_id = couple_playlists.couple_id
        AND m.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "couple members can delete playlists" ON public.couple_playlists;
CREATE POLICY "couple members can delete playlists"
  ON public.couple_playlists
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM couple_members m
      WHERE m.couple_id = couple_playlists.couple_id
        AND m.user_id = auth.uid()
    )
  );

-- ── couple_playlist_songs ────────────────────────────────────────────────────
DROP POLICY IF EXISTS "couple members can view playlist songs" ON public.couple_playlist_songs;
CREATE POLICY "couple members can view playlist songs"
  ON public.couple_playlist_songs
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM couple_playlists pl
      JOIN couple_members m ON m.couple_id = pl.couple_id
      WHERE pl.id = couple_playlist_songs.playlist_id
        AND m.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "couple members can insert playlist songs" ON public.couple_playlist_songs;
CREATE POLICY "couple members can insert playlist songs"
  ON public.couple_playlist_songs
  FOR INSERT
  TO authenticated
  WITH CHECK (
    added_by_user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM couple_playlists pl
      JOIN couple_members m ON m.couple_id = pl.couple_id
      WHERE pl.id = couple_playlist_songs.playlist_id
        AND m.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "couple members can delete playlist songs" ON public.couple_playlist_songs;
CREATE POLICY "couple members can delete playlist songs"
  ON public.couple_playlist_songs
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM couple_playlists pl
      JOIN couple_members m ON m.couple_id = pl.couple_id
      WHERE pl.id = couple_playlist_songs.playlist_id
        AND m.user_id = auth.uid()
    )
  );

-- ── couple_music_plays ───────────────────────────────────────────────────────
DROP POLICY IF EXISTS "couple members can view music plays" ON public.couple_music_plays;
CREATE POLICY "couple members can view music plays"
  ON public.couple_music_plays
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM couple_members m
      WHERE m.couple_id = couple_music_plays.couple_id
        AND m.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "couple members can insert music plays" ON public.couple_music_plays;
CREATE POLICY "couple members can insert music plays"
  ON public.couple_music_plays
  FOR INSERT
  TO authenticated
  WITH CHECK (
    played_by_user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM couple_members m
      WHERE m.couple_id = couple_music_plays.couple_id
        AND m.user_id = auth.uid()
    )
  );

-- ── couple_members ───────────────────────────────────────────────────────────
-- Lets either partner keep display names in sync (admin renames partner in
-- Settings; chat/loveconnect read couple_members.display_name).
--
-- RLS is already enabled on couple_members in the live project (sign-in and
-- invites depend on its existing SELECT/INSERT policies); the line below is
-- idempotent. We add ONLY an UPDATE path here.
--
-- IMPORTANT: the row-level policy alone would allow updating any column
-- (including is_billing_owner / role), which is a privilege-escalation vector
-- between partners. We pin end-user writes to the display_name column with a
-- column-level grant so role / is_billing_owner / couple_id stay
-- service-role-only. The REVOKE is a no-op if the grant was never present.
ALTER TABLE public.couple_members ENABLE ROW LEVEL SECURITY;

REVOKE UPDATE ON public.couple_members FROM authenticated;
GRANT UPDATE (display_name) ON public.couple_members TO authenticated;

DROP POLICY IF EXISTS "couple members can update display_name" ON public.couple_members;
CREATE POLICY "couple members can update display_name"
  ON public.couple_members
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM couple_members m
      WHERE m.couple_id = couple_members.couple_id
        AND m.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM couple_members m
      WHERE m.couple_id = couple_members.couple_id
        AND m.user_id = auth.uid()
    )
  );
