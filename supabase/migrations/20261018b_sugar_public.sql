-- Sugar: the public, multi-user Alexa skill (workers/sugar.js). Each person links Alexa to a
-- Sugar account by signing in with a LibreLinkUp FOLLOWER account made only for Sugar (never
-- their own Libre login); they and their family share to it from the LibreLink app.
-- Only the service role touches these tables (RLS on, no policies).

create table if not exists public.sugar_users (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  email_hash text not null unique,              -- sha256 of the follower email, lower-cased
  libre_cred text not null,                     -- AES-GCM sealed { email, password } (key: sugar_cred_key())
  libre_session text,                           -- AES-GCM sealed LibreLinkUp session
  consents jsonb not null,                      -- { version, at, items: [...] } as accepted on the link page
  alexa_user text,                              -- Amazon user id (skill requests), for the tile
  widget_on boolean not null default false,
  meta jsonb not null default '{}'::jsonb,      -- widgetT, widgetAt, disclaimed, lang
  status text not null default 'active',        -- active | needs_login
  last_seen timestamptz
);
create index if not exists sugar_users_alexa on public.sugar_users (alexa_user);
create index if not exists sugar_users_widget on public.sugar_users (widget_on) where widget_on;

create table if not exists public.sugar_tokens (
  hash text primary key,                        -- sha256 of the token; the token itself is never stored
  user_id uuid not null references public.sugar_users (id) on delete cascade,
  kind text not null check (kind in ('code', 'access', 'refresh')),
  redirect_uri text,
  expires_at timestamptz not null,
  used boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists sugar_tokens_user on public.sugar_tokens (user_id);

alter table public.sugar_users enable row level security;
alter table public.sugar_tokens enable row level security;
revoke all on public.sugar_users, public.sugar_tokens from anon, authenticated;

-- The key that seals the follower logins lives in Supabase Vault, apart from the table. It is made
-- the first time it is asked for; no person ever sees or types it.
create or replace function public.sugar_cred_key() returns text
  language plpgsql security definer set search_path = public, vault, extensions as $$
declare k text;
begin
  select decrypted_secret into k from vault.decrypted_secrets where name = 'sugar_cred_key';
  if k is null then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'base64'), 'sugar_cred_key', 'Sugar: AES-GCM key for sugar_users.libre_cred');
    select decrypted_secret into k from vault.decrypted_secrets where name = 'sugar_cred_key';
  end if;
  return k;
end $$;
revoke all on function public.sugar_cred_key() from public, anon, authenticated;
grant execute on function public.sugar_cred_key() to service_role;
