-- Paired screens and widgets (workers/screens.js): a fridge, TV or tablet shows a short
-- code, su94r Mini enters it, the screen gets its own revocable token. Only hashes of the
-- screen's secret and token are kept; token_once holds the token until the screen collects
-- it once. Service role only: RLS on, no policies, no grants.

create table if not exists public.su94r_screens (
  id           text primary key,
  code         text unique,                 -- shown on the screen while waiting; cleared once paired
  secret_hash  text not null,               -- the waiting screen's polling secret (SHA-256)
  token_hash   text unique,                 -- the paired screen's bearer token (SHA-256)
  token_once   text,                        -- handed to the screen once, then cleared
  name         text,
  kind         text not null default 'screen' check (kind in ('screen', 'widget')),
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,        -- for the code while unpaired
  claimed_at   timestamptz,
  last_seen    timestamptz,
  revoked      boolean not null default false
);

create index if not exists su94r_screens_secret on public.su94r_screens (secret_hash);

alter table public.su94r_screens enable row level security;
revoke all on public.su94r_screens from anon, authenticated;

comment on table public.su94r_screens is 'su94r: paired glucose screens and widgets. Service role only.';
