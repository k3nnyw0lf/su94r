-- su94r family accounts (workers/sugar.js): Dexcom as a source next to the Libre follower, the
-- name to say for a Dexcom person, family screens (a Tesla, a computer, a TV) paired to the
-- family instead of the owner, and a per-family night safety net (the owner's nightCheck logic,
-- Dexcom Follow stays the official alarm).

alter table public.sugar_users
  add column if not exists source text not null default 'libre' check (source in ('libre', 'dexcom')),
  add column if not exists region text not null default 'us' check (region in ('us', 'ous', 'jp')),
  add column if not exists person text,                       -- name to say for a Dexcom person
  add column if not exists units text not null default 'mg/dL' check (units in ('mg/dL', 'mmol/L'));

alter table public.su94r_screens
  add column if not exists sugar_user uuid references public.sugar_users (id) on delete cascade;
create index if not exists su94r_screens_sugar_user on public.su94r_screens (sugar_user);

create table if not exists public.sugar_night (
  user_id uuid primary key references public.sugar_users (id) on delete cascade,
  cfg jsonb not null default '{}'::jsonb,                     -- NIGHT_DEFAULTS overrides; Echo trigger links sealed
  state jsonb not null default '{}'::jsonb,
  last_tick_at timestamptz,
  last_result jsonb,
  updated_at timestamptz not null default now()
);
alter table public.sugar_night enable row level security;
revoke all on public.sugar_night from anon, authenticated;

-- One-time family manage sessions ride in sugar_tokens as kind 'manage'.
alter table public.sugar_tokens drop constraint if exists sugar_tokens_kind_check;
alter table public.sugar_tokens add constraint sugar_tokens_kind_check check (kind in ('code', 'access', 'refresh', 'manage'));
