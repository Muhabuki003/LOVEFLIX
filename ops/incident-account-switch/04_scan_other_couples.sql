-- 04_scan_other_couples.sql — READ ONLY. Exports the identity-bearing D1 fields for EVERY tenant
-- so they can be cross-referenced against the Supabase source of truth to spot other swaps.
--
-- Why this works: D1 has no link back to Supabase, so a swap is only detectable by comparing the
-- partner names stored in D1 (couple_settings / tenant_settings) against the couple_members
-- display names in Supabase for the same admin user_id. Run this, then paste the JSON back to
-- Claude (or compare by hand against the table in README.md "Known admin -> partner mapping").
--
-- Run: wrangler d1 execute loveflix-db --remote --json \
--        --file=ops/incident-account-switch/04_scan_other_couples.sql > d1_tenant_export.json

SELECT
  cs.tenant_id,
  cs.partner_1_name,
  cs.partner_2_name,
  cs.anniversary_date,
  (SELECT COUNT(*) FROM videos v WHERE v.tenant_id = cs.tenant_id) AS n_videos
FROM couple_settings cs
ORDER BY cs.tenant_id;

-- tenant_settings stores names as JSON (adminName / partnerName). Export raw for cross-check.
SELECT
  tenant_id,
  json_extract(data, '$.adminName')   AS admin_name,
  json_extract(data, '$.partnerName') AS partner_name
FROM tenant_settings
ORDER BY tenant_id;
