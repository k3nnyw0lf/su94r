-- Missed-dose reminders (workers/nudges.js) and supplies (workers/supplies.js).
alter table public.su94r_night add column if not exists nudge_enabled boolean not null default true;

create table if not exists public.su94r_supplies (
  pid        text not null,
  item       text not null check (item in ('rapid', 'short', 'intermediate', 'basal', 'mix', 'sensors')),
  on_hand    numeric not null check (on_hand >= 0 and on_hand <= 100000),
  warn_at    numeric not null default 0 check (warn_at >= 0 and warn_at <= 100000),
  refill_on  date,
  set_at     timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (pid, item)
);
alter table public.su94r_supplies enable row level security;
revoke all on public.su94r_supplies from anon, authenticated;
comment on table public.su94r_supplies is 'su94r: insulin and sensors on hand, counted down from logged doses. Service role only.';
