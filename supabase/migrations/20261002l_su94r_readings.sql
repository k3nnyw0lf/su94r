-- The glucose history kept by the server (workers/history.js), 90 days, one row per person and
-- minute. Filled by the 5-minute night check and by su94r Mini's one-time copy. Service role only.
create table if not exists public.su94r_readings (
  pid    text not null,
  t      timestamptz not null,
  mg     smallint not null check (mg between 20 and 600),
  trend  smallint,
  primary key (pid, t)
);
alter table public.su94r_readings enable row level security;
revoke all on public.su94r_readings from anon, authenticated;
comment on table public.su94r_readings is 'su94r: glucose history (90 days) for reports, the phone app and the doctor link. Service role only.';
