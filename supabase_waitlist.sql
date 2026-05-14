-- Run once in Supabase → SQL Editor → New query → paste this → Run.
-- Creates the waitlist table and allows anonymous inserts from the public site.

create table if not exists public.waitlist (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  email       text not null,
  phone       text,
  created_at  timestamptz not null default now()
);

create unique index if not exists waitlist_email_unique on public.waitlist (lower(email));

alter table public.waitlist enable row level security;

drop policy if exists "Anyone can join waitlist" on public.waitlist;
create policy "Anyone can join waitlist"
  on public.waitlist
  for insert
  to anon
  with check (true);
