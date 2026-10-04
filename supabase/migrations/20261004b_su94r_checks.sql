-- Logged besides insulin and carbs (workers/checks.js): meter readings (mg/dL), ketones (mmol/L or a
-- urine result), weight (kg), exercise (minutes) and pills. And su94r Mini's medicine list with the
-- times set for each, for the pill reminders (night.js).
create table if not exists public.su94r_checks (
  id         text primary key check (char_length(id) <= 80),
  pid        text not null,
  t          timestamptz not null,
  kind       text not null check (kind in ('meter', 'ketone', 'weight', 'exercise', 'med')),
  value      numeric,
  unit       text not null default '' check (char_length(unit) <= 12),
  label      text not null default '' check (char_length(label) <= 60),
  by         text not null default '' check (char_length(by) <= 40),
  source     text not null default 'phone' check (source in ('phone', 'extension', 'reminder', 'telegram')),
  deleted    boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists su94r_checks_pid_t on public.su94r_checks(pid, t desc);
alter table public.su94r_checks enable row level security;
revoke all on public.su94r_checks from anon, authenticated;
comment on table public.su94r_checks is 'su94r: meter readings, ketones, weight, exercise and pills logged in the phone app or su94r Mini. Service role only.';

alter table public.su94r_night
  add column if not exists meds jsonb not null default '[]'::jsonb,
  add column if not exists meds_pid text;
