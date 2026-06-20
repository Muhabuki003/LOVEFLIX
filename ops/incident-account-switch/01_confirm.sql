-- 01_confirm.sql — READ ONLY. Confirms whether the two accounts' content is swapped in D1.
--
-- D1 content is keyed by tenant_id = the couple ADMIN's Supabase auth user_id.
-- Verified-correct Supabase identity (do NOT change these):
--   adrienmuhabukibusiness@gmail.com -> e13067c6-a58f-4267-bf6b-1c98f53eceeb  (couple d15e138f, partner: Diane)
--   loveflixsupport@gmail.com        -> 00eb31f6-bb87-4656-810b-91822ccf7901  (couple a3842845, partners: Jessa, Isabel)
--
-- If the names/videos listed under each tenant_id below belong to the OTHER email,
-- the swap is confirmed and 02_swap.sql will put them back.
--
-- Run: wrangler d1 execute loveflix-db --remote --file=ops/incident-account-switch/01_confirm.sql

SELECT 'couple_settings' AS tbl, tenant_id, partner_1_name, partner_2_name, anniversary_date
FROM couple_settings
WHERE tenant_id IN ('e13067c6-a58f-4267-bf6b-1c98f53eceeb','00eb31f6-bb87-4656-810b-91822ccf7901');

SELECT 'tenant_settings' AS tbl, tenant_id, substr(data, 1, 500) AS data_preview
FROM tenant_settings
WHERE tenant_id IN ('e13067c6-a58f-4267-bf6b-1c98f53eceeb','00eb31f6-bb87-4656-810b-91822ccf7901');

SELECT 'videos' AS tbl, tenant_id, COUNT(*) AS n_videos, GROUP_CONCAT(title, ' | ') AS titles
FROM videos
WHERE tenant_id IN ('e13067c6-a58f-4267-bf6b-1c98f53eceeb','00eb31f6-bb87-4656-810b-91822ccf7901')
GROUP BY tenant_id;
