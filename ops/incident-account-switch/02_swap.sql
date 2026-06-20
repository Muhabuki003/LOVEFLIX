-- 02_swap.sql — DESTRUCTIVE. Swaps the two accounts' D1 content back to the correct owner.
--
-- Only run AFTER 01_confirm.sql shows the content is actually swapped, and AFTER a backup
-- (unswap.sh --apply does the backup for you).
--
-- Mechanism: a 3-step park-via-sentinel swap. The sentinel UUID below is not a real Supabase
-- user and cannot collide with any tenant_id. Order matters; run top to bottom exactly once
-- from a clean (un-applied) state.
--
--   A = e13067c6-a58f-4267-bf6b-1c98f53eceeb  (adrienmuhabukibusiness@gmail.com)
--   B = 00eb31f6-bb87-4656-810b-91822ccf7901  (loveflixsupport@gmail.com)
--   SENTINEL = ffffffff-ffff-ffff-ffff-ffffffffffff
--
-- Run: wrangler d1 execute loveflix-db --remote --file=ops/incident-account-switch/02_swap.sql
--
-- NOT swapped on purpose:
--   * watch_progress / favorites  -> keyed by the real viewer's user_id, already correct.
--   * couple_playlists / couple_music_plays -> keyed by Supabase couple_id, not tenant_id.
--     (If 01_confirm shows music is also swapped, handle separately — see README.)

-- ---- videos (tenant_id is non-unique; multiple rows per tenant) ----
UPDATE videos SET tenant_id='ffffffff-ffff-ffff-ffff-ffffffffffff' WHERE tenant_id='e13067c6-a58f-4267-bf6b-1c98f53eceeb';
UPDATE videos SET tenant_id='e13067c6-a58f-4267-bf6b-1c98f53eceeb' WHERE tenant_id='00eb31f6-bb87-4656-810b-91822ccf7901';
UPDATE videos SET tenant_id='00eb31f6-bb87-4656-810b-91822ccf7901' WHERE tenant_id='ffffffff-ffff-ffff-ffff-ffffffffffff';

-- ---- tenant_settings (tenant_id is PRIMARY KEY; sentinel avoids transient PK collision) ----
UPDATE tenant_settings SET tenant_id='ffffffff-ffff-ffff-ffff-ffffffffffff' WHERE tenant_id='e13067c6-a58f-4267-bf6b-1c98f53eceeb';
UPDATE tenant_settings SET tenant_id='e13067c6-a58f-4267-bf6b-1c98f53eceeb' WHERE tenant_id='00eb31f6-bb87-4656-810b-91822ccf7901';
UPDATE tenant_settings SET tenant_id='00eb31f6-bb87-4656-810b-91822ccf7901' WHERE tenant_id='ffffffff-ffff-ffff-ffff-ffffffffffff';

-- ---- couple_settings (tenant_id is PRIMARY KEY) ----
UPDATE couple_settings SET tenant_id='ffffffff-ffff-ffff-ffff-ffffffffffff' WHERE tenant_id='e13067c6-a58f-4267-bf6b-1c98f53eceeb';
UPDATE couple_settings SET tenant_id='e13067c6-a58f-4267-bf6b-1c98f53eceeb' WHERE tenant_id='00eb31f6-bb87-4656-810b-91822ccf7901';
UPDATE couple_settings SET tenant_id='00eb31f6-bb87-4656-810b-91822ccf7901' WHERE tenant_id='ffffffff-ffff-ffff-ffff-ffffffffffff';
