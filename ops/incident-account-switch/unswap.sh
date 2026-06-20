#!/usr/bin/env bash
# unswap.sh — Orchestrates the account-content un-switch for the two affected LoveFlix accounts.
#
#   adrienmuhabukibusiness@gmail.com  ->  e13067c6-a58f-4267-bf6b-1c98f53eceeb
#   loveflixsupport@gmail.com         ->  00eb31f6-bb87-4656-810b-91822ccf7901
#
# The Supabase identity layer was verified CORRECT and is left untouched. This only repairs the
# Cloudflare D1 content layer, where the two tenants' rows are tagged with each other's user_id.
#
# Usage:
#   ./unswap.sh            # dry run: prints current (confirm) state only — change nothing
#   ./unswap.sh --apply    # backs up affected rows, runs the swap, then prints verification
#
# Requires: wrangler logged in to the Cloudflare account that owns the `loveflix-db` D1 database.
# Run from the repo root (where wrangler.toml lives).

set -euo pipefail

DB="loveflix-db"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
A="e13067c6-a58f-4267-bf6b-1c98f53eceeb"   # adrienmuhabukibusiness@gmail.com
B="00eb31f6-bb87-4656-810b-91822ccf7901"   # loveflixsupport@gmail.com

echo "==> Confirming current D1 state (read only)"
wrangler d1 execute "$DB" --remote --file="$HERE/01_confirm.sql"

if [[ "${1:-}" != "--apply" ]]; then
  echo
  echo "Dry run complete. Review the output above. If the content under each tenant_id belongs to"
  echo "the OTHER account, re-run with --apply to back up and swap it back:"
  echo "    ./unswap.sh --apply"
  exit 0
fi

TS="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="$HERE/backup_$TS"
mkdir -p "$BACKUP_DIR"

echo "==> Backing up affected rows to $BACKUP_DIR before any change"
wrangler d1 execute "$DB" --remote --json --command \
  "SELECT * FROM videos          WHERE tenant_id IN ('$A','$B');" > "$BACKUP_DIR/videos.json"
wrangler d1 execute "$DB" --remote --json --command \
  "SELECT * FROM tenant_settings WHERE tenant_id IN ('$A','$B');" > "$BACKUP_DIR/tenant_settings.json"
wrangler d1 execute "$DB" --remote --json --command \
  "SELECT * FROM couple_settings WHERE tenant_id IN ('$A','$B');" > "$BACKUP_DIR/couple_settings.json"
echo "    backup written."

echo "==> Applying swap (02_swap.sql)"
wrangler d1 execute "$DB" --remote --file="$HERE/02_swap.sql"

echo "==> Verifying (03_verify.sql) — orphan counts must all be 0"
wrangler d1 execute "$DB" --remote --file="$HERE/03_verify.sql"

echo
echo "Done. If anything looks wrong, the pre-swap rows are saved in $BACKUP_DIR."
echo "Re-running 02_swap.sql a second time would swap them AGAIN — only run the swap once."
