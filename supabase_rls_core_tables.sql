-- ─────────────────────────────────────────────────────────────────────────────
-- LoveFlix — RLS for core couple tables (SECURITY AUDIT 2026-08-28)
--
-- These Supabase tables are queried via PostgREST from the app but had NO RLS
-- policies in the repo (their DDL was created out-of-band in the Supabase
-- console). They hold couple-private data (live location, call logs, presence,
-- invite tokens) and MUST be row-level-locked before public launch.
--
-- ⚠️ APPLY IN SUPABASE → SQL EDITOR, then verify each with a no-auth REST GET
--    (should return [] / 401 / 403, never rows).
-- ⚠️ VERIFY COLUMN NAMES against the live schema first — these policies were
--    written from the app's query patterns (user_id / couple_id), not from the
--    actual DDL which is not in this repo.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── couple_locations ─────────────────────────────────────────────────────────
ALTER TABLE public.couple_locations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "couple members can view locations" ON public.couple_locations;
CREATE POLICY "couple members can view locations"
  ON public.couple_locations FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.couple_members m
    WHERE m.couple_id = couple_locations.couple_id
      AND m.user_id = auth.uid()
  ));

DROP POLICY IF EXISTS "couple members can upsert locations" ON public.couple_locations;
CREATE POLICY "couple members can upsert locations"
  ON public.couple_locations FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.couple_members m
    WHERE m.couple_id = couple_locations.couple_id
      AND m.user_id = auth.uid()
  ));

DROP POLICY IF EXISTS "couple members can update locations" ON public.couple_locations;
CREATE POLICY "couple members can update locations"
  ON public.couple_locations FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.couple_members m
    WHERE m.couple_id = couple_locations.couple_id
      AND m.user_id = auth.uid()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.couple_members m
    WHERE m.couple_id = couple_locations.couple_id
      AND m.user_id = auth.uid()
  ));

-- ── call_logs ────────────────────────────────────────────────────────────────
ALTER TABLE public.call_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "couple members can view call logs" ON public.call_logs;
CREATE POLICY "couple members can view call logs"
  ON public.call_logs FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.couple_members m
    WHERE m.couple_id = call_logs.couple_id
      AND m.user_id = auth.uid()
  ));

DROP POLICY IF EXISTS "couple members can insert call logs" ON public.call_logs;
CREATE POLICY "couple members can insert call logs"
  ON public.call_logs FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.couple_members m
    WHERE m.couple_id = call_logs.couple_id
      AND m.user_id = auth.uid()
  ));

-- ── couple_presence ──────────────────────────────────────────────────────────
ALTER TABLE public.couple_presence ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "couple members can view presence" ON public.couple_presence;
CREATE POLICY "couple members can view presence"
  ON public.couple_presence FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.couple_members m
    WHERE m.couple_id = couple_presence.couple_id
      AND m.user_id = auth.uid()
  ));

DROP POLICY IF EXISTS "couple members can upsert presence" ON public.couple_presence;
CREATE POLICY "couple members can upsert presence"
  ON public.couple_presence FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.couple_members m
    WHERE m.couple_id = couple_presence.couple_id
      AND m.user_id = auth.uid()
  ));

-- ── couple_invites ───────────────────────────────────────────────────────────
-- Invite tokens are bearer credentials: exposing the token list lets anyone
-- join arbitrary couples. Do NOT add a broad anon SELECT policy. Instead:
--   (1) authenticated members of a couple can see that couple's invites;
--   (2) the join flow validates a token via a SECURITY DEFINER RPC that returns
--       only the matching (unused) invite — never a bulk list.
ALTER TABLE public.couple_invites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "couple members can view invites" ON public.couple_invites;
CREATE POLICY "couple members can view invites"
  ON public.couple_invites FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.couple_members m
    WHERE m.couple_id = couple_invites.couple_id
      AND m.user_id = auth.uid()
  ));

-- SECURITY DEFINER RPC: validate an invite token without exposing the list.
CREATE OR REPLACE FUNCTION public.get_invite_by_token(p_token text)
RETURNS TABLE (id uuid, couple_id uuid, email text, used boolean, created_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT id, couple_id, email, used, created_at
  FROM public.couple_invites
  WHERE token = p_token AND used = false
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.get_invite_by_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_invite_by_token(text) TO anon, authenticated;

-- NOTE: if join.html currently SELECTs couple_invites directly with the anon
-- key, it must be switched to call rpc/get_invite_by_token instead, or the
-- invite-validation flow will break once RLS blocks anon SELECT.
