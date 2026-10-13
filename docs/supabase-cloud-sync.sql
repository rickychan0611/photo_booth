-- Run once in the Supabase SQL editor for the project used by Photo Booth.
-- The booth secret is never stored. Only its SHA-256 hash is kept and checked.

create extension if not exists pgcrypto;

create table if not exists public.booth_sync_profiles (
  id text primary key,
  event_id text not null,
  sync_token_hash text not null,
  revision bigint not null,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

create or replace function public.touch_booth_sync_profile()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists touch_booth_sync_profile on public.booth_sync_profiles;
create trigger touch_booth_sync_profile
before update on public.booth_sync_profiles
for each row execute function public.touch_booth_sync_profile();

create or replace function public.booth_sync_request_secret_hash()
returns text
language sql
stable
as $$
  select encode(
    digest(
      coalesce((current_setting('request.headers', true)::json ->> 'x-booth-sync-secret'), ''),
      'sha256'
    ),
    'hex'
  );
$$;

alter table public.booth_sync_profiles enable row level security;

drop policy if exists "booth sync read" on public.booth_sync_profiles;
create policy "booth sync read" on public.booth_sync_profiles
for select to anon
using (sync_token_hash = public.booth_sync_request_secret_hash());

drop policy if exists "booth sync insert" on public.booth_sync_profiles;
create policy "booth sync insert" on public.booth_sync_profiles
for insert to anon
with check (sync_token_hash = public.booth_sync_request_secret_hash());

drop policy if exists "booth sync update" on public.booth_sync_profiles;
create policy "booth sync update" on public.booth_sync_profiles
for update to anon
using (sync_token_hash = public.booth_sync_request_secret_hash())
with check (sync_token_hash = public.booth_sync_request_secret_hash());

insert into storage.buckets (id, name, public)
values ('booth-sync', 'booth-sync', false)
on conflict (id) do update set public = false;

drop policy if exists "booth sync asset read" on storage.objects;
create policy "booth sync asset read" on storage.objects
for select to anon
using (
  bucket_id = 'booth-sync'
  and (storage.foldername(name))[1] = public.booth_sync_request_secret_hash()
);

drop policy if exists "booth sync asset insert" on storage.objects;
create policy "booth sync asset insert" on storage.objects
for insert to anon
with check (
  bucket_id = 'booth-sync'
  and (storage.foldername(name))[1] = public.booth_sync_request_secret_hash()
);

drop policy if exists "booth sync asset update" on storage.objects;
create policy "booth sync asset update" on storage.objects
for update to anon
using (
  bucket_id = 'booth-sync'
  and (storage.foldername(name))[1] = public.booth_sync_request_secret_hash()
)
with check (
  bucket_id = 'booth-sync'
  and (storage.foldername(name))[1] = public.booth_sync_request_secret_hash()
);

grant select, insert, update on public.booth_sync_profiles to anon;
