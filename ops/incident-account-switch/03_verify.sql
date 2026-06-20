-- 03_verify.sql — READ ONLY. Run after 02_swap.sql to confirm content now matches the owner.
--
-- Expected after the fix:
--   tenant_id e13067c6-... shows adrienmuhabukibusiness's content (couple with Diane)
--   tenant_id 00eb31f6-... shows loveflixsupport's content (couple with Jessa / Isabel)
--
-- Also confirms the sentinel left no orphaned rows behind (all three counts must be 0).
--
-- Run: wrangler d1 execute loveflix-db --remote --file=ops/incident-account-switch/03_verify.sql

SELECT 'couple_settings' AS tbl, tenant_id, partner_1_name, partner_2_name
FROM couple_settings
WHERE tenant_id IN ('e13067c6-a58f-4267-bf6b-1c98f53eceeb','00eb31f6-bb87-4656-810b-91822ccf7901');

SELECT 'videos' AS tbl, tenant_id, COUNT(*) AS n_videos
FROM videos
WHERE tenant_id IN ('e13067c6-a58f-4267-bf6b-1c98f53eceeb','00eb31f6-bb87-4656-810b-91822ccf7901')
GROUP BY tenant_id;

-- Sentinel leak check — every count MUST be 0.
SELECT 'orphan_videos'          AS check_name, COUNT(*) AS must_be_zero FROM videos          WHERE tenant_id='ffffffff-ffff-ffff-ffff-ffffffffffff'
UNION ALL
SELECT 'orphan_tenant_settings' AS check_name, COUNT(*) AS must_be_zero FROM tenant_settings WHERE tenant_id='ffffffff-ffff-ffff-ffff-ffffffffffff'
UNION ALL
SELECT 'orphan_couple_settings' AS check_name, COUNT(*) AS must_be_zero FROM couple_settings WHERE tenant_id='ffffffff-ffff-ffff-ffff-ffffffffffff';
