# LOVEFLIX — Project Rules

## Supabase / Database

- **Every new Supabase table MUST have RLS enabled.** No migration that adds a `CREATE TABLE` may be applied without a matching `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` and at least one policy in the same file.
- Follow the existing policy pattern: use `auth.uid()` and check membership via `couple_members` for couple-scoped tables, or `anon` INSERT + no SELECT for public-facing tables (e.g. `waitlist`).
- The D1 (Cloudflare) schema (`schema.sql`) is separate — RLS does not apply there.
