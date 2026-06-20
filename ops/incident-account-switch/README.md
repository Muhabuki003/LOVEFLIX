# Incident: two accounts showing each other's content

**Reported:** account `adrienmuhabukibusiness@gmail.com` and `loveflixsupport@gmail.com` "switched" —
signing into one shows the other's content.

## Diagnosis (what was verified)

The **Supabase identity layer is correct and was NOT touched.** Verified against project
`jeblgjjutyzzdursjqnn` (`LOVEFLIX DB`):

| Account | Supabase `auth` user_id | Couple | Role |
|---|---|---|---|
| `adrienmuhabukibusiness@gmail.com` | `e13067c6-a58f-4267-bf6b-1c98f53eceeb` | `d15e138f-8e16-4f4b-882d-65f5cb82cbe3` (partner: Diane) | admin / billing owner |
| `loveflixsupport@gmail.com` | `00eb31f6-bb87-4656-810b-91822ccf7901` | `a3842845-8ffb-4d8c-9430-606c054979b8` (partners: Jessa, Isabel) | admin / billing owner |

- Both `auth.users` rows **and both** `auth.identities` (email + Google) match their own email — no email swap.
- `couple_members.user_id` is unique; each user is admin of exactly their own couple — membership is consistent.
- `couple_members` SELECT RLS is `user_id = auth.uid() OR couple_id = get_my_couple_id()` — sound; the
  Worker's `verifyTenantAccess` cannot be tricked into cross-tenant reads.

**Conclusion:** the switch is in the **Cloudflare D1 content layer**, not Supabase. D1 content is keyed by
`tenant_id = the admin's Supabase user_id` (`videos.tenant_id`, `tenant_settings.tenant_id`,
`couple_settings.tenant_id`). The two tenants' rows are tagged with each other's `user_id`.

## Fix (run from repo root, with wrangler logged into the Cloudflare account)

```bash
# 1. Dry run — see current state, change nothing
./ops/incident-account-switch/unswap.sh

# 2. If confirmed swapped, back up + swap + verify
./ops/incident-account-switch/unswap.sh --apply
```

Or run the SQL files individually with `wrangler d1 execute loveflix-db --remote --file=...`:
`01_confirm.sql` → `02_swap.sql` → `03_verify.sql`.

**Only run `02_swap.sql` once** — it swaps A↔B, so running it twice puts them back to the broken state.
`unswap.sh --apply` writes a JSON backup of the affected rows to `backup_<timestamp>/` first.

Not swapped on purpose: `watch_progress` / `favorites` (keyed to the real viewer) and
`couple_playlists` / `couple_music_plays` (keyed to Supabase `couple_id`). If `01_confirm` shows music
history is also crossed, handle it separately — those swap on `couple_id`
(`d15e138f…` ↔ `a3842845…`), not `tenant_id`.

## Finding the others ("probably happened elsewhere too")

```bash
wrangler d1 execute loveflix-db --remote --json \
  --file=ops/incident-account-switch/04_scan_other_couples.sql > d1_tenant_export.json
```

Cross-reference the partner names D1 stores per `tenant_id` against this Supabase source of truth
(admin user_id → the partner who should appear). A mismatch = another swap.

| Admin user_id (= D1 tenant_id) | Admin email | Expected partner name(s) in D1 |
|---|---|---|
| `e13067c6-…eceeb` | adrienmuhabukibusiness@gmail.com | Diane |
| `00eb31f6-…f7901` | loveflixsupport@gmail.com | Jessa, Isabel |
| `3577c71b-…3093` | jacokobie@gmail.com | Alpha |
| `11a06b9b-…0e49` | crykabelly@yahoo.com | Belina |
| `97a0b613-…ba8d` | karuallan8@gmail.com | Jennifer |

(Paste `d1_tenant_export.json` back to Claude to have the cross-check done automatically.)

## Preventing recurrence

The root mechanism that *introduced* the swap can only be pinned down with the D1 row history, but the
investigation surfaced concrete fragilities worth closing:

1. **Split-brain identity with no integrity check.** D1 `tenant_id` mirrors a Supabase `user_id` with no
   foreign key or reconciliation. Add a scheduled job that runs the `04_scan` cross-check and alerts on any
   D1 tenant whose stored partner names don't match Supabase `couple_members` for that couple.
2. **Inconsistent tenant keying on upload.** `createVideo` writes `tenant_id` from the verified
   `x-tenant-id` (the couple creator), but `presignVideoUpload` / `confirmVideoUpload`
   (`functions/api/[[path]].js`) write `tenant_id = user.id` (whoever uploaded). For a partner upload these
   disagree. Make all write paths resolve the tenant the same way (`verifyTenantAccess`).
3. **`couple_settings` keyed on `user.id`, not the verified creator tenant.** `getCoupleSettings` /
   `patchCoupleSettings` use `user.id` directly while videos/tenant_settings use the creator id — a partner
   and an admin in the same couple read/write different `couple_settings` rows. Align these.
4. **Audit any admin/ops tooling that writes `tenant_id`.** Two specific staff accounts swapping cleanly is
   most consistent with a manual data operation or a historical account reassignment. Log who/what writes
   `tenant_id` and gate it.

Items 2–4 are code changes outside this data-repair script and should be reviewed/tested separately rather
than shipped as part of the emergency fix.
