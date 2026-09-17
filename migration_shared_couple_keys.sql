-- ═══════════════════════════════════════════════════════════════════════════
--  LoveFlix — shared couple keys (one-off merge of the split per-user buckets)
--  Idempotent · lossless · no duplicates
-- ═══════════════════════════════════════════════════════════════════════════
--
--  WHY
--  date_ideas.couple_id / couple_photos.couple_id / couple_settings.tenant_id
--  used to hold the CALLER'S OWN user id, so each partner wrote into their own
--  private bucket and neither could see the other's rows. They now key on the
--  couple's real shared id: Supabase `couple_members.couple_id`.
--
--  DO I ACTUALLY NEED TO RUN THIS?
--  Usually no. functions/api/[[path]].js performs exactly this merge in-process
--  (adoptLegacyCoupleRows → resolveCoupleKey), idempotently, on the first
--  couple-scoped request after the fix is deployed. This file exists for a
--  manual / audited run. Both paths are safe to combine — they are idempotent
--  and neither duplicates a row.
--
--  ⚠️ ORDER MATTERS — run this only AFTER the fix is live (merged to main).
--     The pre-fix code reads `WHERE couple_id = <caller's user id>`, so
--     re-keying first hides the rows from the live site (empty album, no
--     countdown) until the deploy lands.
--
--  ⚠️ BACK UP FIRST — reference export (JSON + restorable SQL + manifest, with
--     row counts and sha256s): /root/lf-migration-backup/<UTC timestamp>/
--     produced by `python3 /root/lf-backup.py`. Verify it before step 2.
--
--  ⚠️ NEVER GUESS THE MAPPING. The user_id → couple_id pairs must come from an
--     authoritative source: Supabase `couple_members` (couple_id of a member
--     row) or, if you have no Supabase credentials, `couple_invites`
--     (created_by = one member, accepted_by = the other, both rows carry that
--     couple's couple_id). Cross-check against D1: the tenant that holds the
--     couple's `videos` is the tenant the clients send as x-tenant-id, and
--     couple_settings.partner_1_name / partner_2_name should name the two
--     people in the invite pair.
--
--  HOW TO RUN: the D1 /raw endpoint accepts ONE statement per call, so run the
--  statements below one at a time (comments stripped).
--
--  VERIFY AFTERWARDS (expected: one bucket per table, nothing lost):
--    SELECT couple_id, COUNT(*) FROM date_ideas   GROUP BY couple_id;
--    SELECT couple_id, COUNT(*) FROM couple_photos GROUP BY couple_id;
--    SELECT tenant_id, anniversary_date, partner_1_name, partner_2_name FROM couple_settings;
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Mapping table (evidence-backed pairs only).
CREATE TABLE IF NOT EXISTS couple_key_map (
  member_tenant_id TEXT PRIMARY KEY,   -- a partner's auth user id
  couple_id        TEXT NOT NULL,      -- the couple's real shared id
  note             TEXT                -- where this pair came from
);

-- 2. Populate it. One row per partner of every couple whose buckets are split.
--    Example shape (values MUST come from the evidence described above):
-- INSERT OR IGNORE INTO couple_key_map (member_tenant_id, couple_id, note) VALUES
--   ('<member user id A>', '<couple uuid>', 'couple_invites.created_by'),
--   ('<member user id B>', '<couple uuid>', 'couple_invites.accepted_by');

-- 3. date_ideas — pure re-key: only couple_id changes; id, content and
--    timestamps are untouched, so a row can never be duplicated. After the
--    first run nothing matches and this is a no-op.
UPDATE date_ideas
   SET couple_id = (SELECT m.couple_id FROM couple_key_map m
                     WHERE m.member_tenant_id = date_ideas.couple_id)
 WHERE couple_id IN (SELECT member_tenant_id FROM couple_key_map)
   AND couple_id NOT IN (SELECT couple_id FROM couple_key_map);

-- 4. couple_photos — same.
UPDATE couple_photos
   SET couple_id = (SELECT m.couple_id FROM couple_key_map m
                     WHERE m.member_tenant_id = couple_photos.couple_id)
 WHERE couple_id IN (SELECT member_tenant_id FROM couple_key_map)
   AND couple_id NOT IN (SELECT couple_id FROM couple_key_map);

-- 5. couple_settings — the primary key IS tenant_id, so two member rows cannot
--    both be re-keyed onto one id. Materialise the shared row from the member
--    rows (the newest one wins the OR IGNORE insert), keeping any existing
--    shared row untouched.
INSERT OR IGNORE INTO couple_settings
  (tenant_id, anniversary_date, partner_1_name, partner_2_name, is_locked,
   brand_accent_color, notifications_enabled, privacy_level, updated_at)
SELECT m.couple_id, s.anniversary_date, s.partner_1_name, s.partner_2_name, s.is_locked,
       s.brand_accent_color, s.notifications_enabled, s.privacy_level, s.updated_at
  FROM couple_settings s
  JOIN couple_key_map m ON m.member_tenant_id = s.tenant_id
 WHERE s.tenant_id NOT IN (SELECT couple_id FROM couple_key_map)
 ORDER BY s.updated_at DESC;

-- 6. Backfill anything still empty on the shared row from a member row, so no
--    field that existed before is dropped by the merge.
UPDATE couple_settings
   SET anniversary_date = COALESCE(NULLIF(anniversary_date, ''), (
         SELECT s2.anniversary_date FROM couple_settings s2
           JOIN couple_key_map m2 ON m2.member_tenant_id = s2.tenant_id
          WHERE m2.couple_id = couple_settings.tenant_id
            AND COALESCE(s2.anniversary_date, '') <> ''
          ORDER BY s2.updated_at DESC LIMIT 1)),
       partner_1_name = COALESCE(NULLIF(partner_1_name, ''), (
         SELECT s2.partner_1_name FROM couple_settings s2
           JOIN couple_key_map m2 ON m2.member_tenant_id = s2.tenant_id
          WHERE m2.couple_id = couple_settings.tenant_id
            AND COALESCE(s2.partner_1_name, '') <> ''
          ORDER BY s2.updated_at DESC LIMIT 1)),
       partner_2_name = COALESCE(NULLIF(partner_2_name, ''), (
         SELECT s2.partner_2_name FROM couple_settings s2
           JOIN couple_key_map m2 ON m2.member_tenant_id = s2.tenant_id
          WHERE m2.couple_id = couple_settings.tenant_id
            AND COALESCE(s2.partner_2_name, '') <> ''
          ORDER BY s2.updated_at DESC LIMIT 1)),
       brand_accent_color = COALESCE(NULLIF(brand_accent_color, ''), (
         SELECT s2.brand_accent_color FROM couple_settings s2
           JOIN couple_key_map m2 ON m2.member_tenant_id = s2.tenant_id
          WHERE m2.couple_id = couple_settings.tenant_id
            AND COALESCE(s2.brand_accent_color, '') <> ''
          ORDER BY s2.updated_at DESC LIMIT 1)),
       privacy_level = COALESCE(NULLIF(privacy_level, ''), (
         SELECT s2.privacy_level FROM couple_settings s2
           JOIN couple_key_map m2 ON m2.member_tenant_id = s2.tenant_id
          WHERE m2.couple_id = couple_settings.tenant_id
            AND COALESCE(s2.privacy_level, '') <> ''
          ORDER BY s2.updated_at DESC LIMIT 1)),
       updated_at = COALESCE((
         SELECT MAX(s2.updated_at) FROM couple_settings s2
           JOIN couple_key_map m2 ON m2.member_tenant_id = s2.tenant_id
          WHERE m2.couple_id = couple_settings.tenant_id), updated_at)
 WHERE tenant_id IN (SELECT couple_id FROM couple_key_map);

-- 7. A lock stays a lock (locked if either partner's row was locked).
UPDATE couple_settings
   SET is_locked = 1
 WHERE tenant_id IN (
         SELECT m.couple_id FROM couple_settings s
           JOIN couple_key_map m ON m.member_tenant_id = s.tenant_id
          WHERE s.is_locked = 1);

-- 8. Drop the member rows. Their values are all present on the shared row by
--    now (steps 5–7), so nothing is lost — this is the only destructive step.
DELETE FROM couple_settings
 WHERE tenant_id IN (SELECT member_tenant_id FROM couple_key_map)
   AND tenant_id NOT IN (SELECT couple_id FROM couple_key_map);

-- 9. Optional cleanup once verified:
-- DROP TABLE couple_key_map;
