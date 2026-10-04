-- Insights: the time-in-range goal and the rapid insulin's curve (for active insulin) on the night
-- row; daily summaries kept for years (the readings themselves are kept 90 days) for the months view
-- and streaks; doctor visits for the calendar feed; the calendar feed's link (kind 'calendar').
alter table public.su94r_night
  add column if not exists goal_tir integer not null default 70 check (goal_tir between 50 and 95),
  add column if not exists rapid_insulin text check (rapid_insulin in ('lyumjev', 'fiasp', 'novorapid', 'humalog', 'apidra'));

create table if not exists public.su94r_daily (
  pid       text not null,
  day       date not null,
  readings  integer not null,
  mean      numeric not null,
  in_range  numeric not null,
  below     numeric not null,
  above     numeric not null,
  lows      integer not null default 0,
  primary key (pid, day)
);
alter table public.su94r_daily enable row level security;
revoke all on public.su94r_daily from anon, authenticated;
comment on table public.su94r_daily is 'su94r: one row per person and local day (readings, average, time in ranges, lows). Service role only.';

create table if not exists public.su94r_appointments (
  id         uuid primary key default gen_random_uuid(),
  pid        text not null,
  at         timestamptz not null,
  title      text not null check (char_length(title) between 1 and 80),
  place      text not null default '' check (char_length(place) <= 120),
  created_at timestamptz not null default now()
);
create index if not exists su94r_appointments_pid_at on public.su94r_appointments(pid, at);
alter table public.su94r_appointments enable row level security;
revoke all on public.su94r_appointments from anon, authenticated;
comment on table public.su94r_appointments is 'su94r: doctor visits typed into the phone app, for the calendar feed. Service role only.';

alter table public.su94r_screens drop constraint if exists su94r_screens_kind_check;
alter table public.su94r_screens add constraint su94r_screens_kind_check
  check (kind in ('screen', 'widget', 'ai', 'owner', 'doctor', 'emergency', 'calendar'));
