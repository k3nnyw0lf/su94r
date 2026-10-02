-- Night safety net (workers/night.js): low-glucose alerts on the phone through ntfy, checked
-- every 5 minutes by a database cron. One row: settings, the private ntfy topics, the state of
-- each open low and the last check. Service role only: RLS on, no policies, no grants.
create table if not exists public.su94r_night (
  id            smallint primary key default 1 check (id = 1),
  enabled       boolean not null default true,
  time_zone     text not null default 'America/New_York',
  low_mgdl      integer not null default 70 check (low_mgdl between 60 and 100),
  severe_mgdl   integer not null default 55 check (severe_mgdl between 40 and 70),
  night_start   integer not null default 22 check (night_start between 0 and 23),
  night_end     integer not null default 7 check (night_end between 0 and 23),
  care_enabled  boolean not null default false,
  self_topic    text not null,
  care_topic    text not null,
  state         jsonb not null default '{}'::jsonb,
  last_tick_at  timestamptz,
  last_result   jsonb,
  updated_at    timestamptz not null default now()
);
alter table public.su94r_night enable row level security;
revoke all on public.su94r_night from anon, authenticated;
comment on table public.su94r_night is 'su94r: night low alerts (settings, private ntfy topics, open lows). Service role only.';
