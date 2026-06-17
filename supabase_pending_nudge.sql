-- ─────────────────────────────────────────────────────────────────────────────
-- Lola Knowledge Layer §2 — pending_nudge
--
-- Proactive nudges are PER ACCOUNT, not per couple: Partner A and Partner B can
-- get different nudges (or none) on the same day. The scheduled sweep Worker
-- (nudges/worker.js) evaluates the trigger table per account and writes one row
-- here; each client fetches its own pending nudge on app open.
--
-- RLS is mandatory (LOVEFLIX project rule): a partner may only read/update their
-- OWN nudges, and only within a couple they belong to. INSERT is service-role
-- only (the sweep Worker) — there is intentionally no authenticated INSERT policy.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.pending_nudge (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id     uuid NOT NULL,
  user_id       uuid NOT NULL,                 -- the account this nudge is for
  trigger       text NOT NULL,                 -- chat_drought | call_drought | ...
  message       text NOT NULL,                 -- Lola-written copy
  actions       jsonb NOT NULL DEFAULT '[]',   -- optional {type,payload}[] (spec §4)
  created_at    timestamptz NOT NULL DEFAULT now(),
  delivered_at  timestamptz,                   -- set when the client surfaces it
  dismissed_at  timestamptz                    -- set when the partner dismisses it
);

-- One undelivered nudge per account at a time (the sweep upserts on this).
CREATE UNIQUE INDEX IF NOT EXISTS pending_nudge_one_open_per_user
  ON public.pending_nudge (user_id)
  WHERE delivered_at IS NULL AND dismissed_at IS NULL;

CREATE INDEX IF NOT EXISTS pending_nudge_user_open
  ON public.pending_nudge (user_id, created_at DESC)
  WHERE delivered_at IS NULL;

ALTER TABLE public.pending_nudge ENABLE ROW LEVEL SECURITY;

-- A partner can read only their own nudges, and only within their couple.
CREATE POLICY "own nudges select"
  ON public.pending_nudge
  FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.couple_members m
      WHERE m.couple_id = pending_nudge.couple_id
        AND m.user_id = auth.uid()
    )
  );

-- A partner can mark their own nudge delivered/dismissed (no other columns).
CREATE POLICY "own nudges update"
  ON public.pending_nudge
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- No INSERT/DELETE policy for `authenticated`: only the service-role sweep Worker
-- (which bypasses RLS) may create nudges, keeping delivery async and tamper-proof.
