-- Lab results typed into the phone app (workers/labs.js), shown in the 14-day report and the doctor's link.
create table if not exists public.su94r_labs (
  id         uuid primary key default gen_random_uuid(),
  pid        text not null,
  taken_on   date not null,
  kind       text not null check (kind in ('a1c', 'other')),
  name       text not null check (char_length(name) between 1 and 40),
  value      numeric not null,
  unit       text not null default '' check (char_length(unit) <= 16),
  created_at timestamptz not null default now()
);
create index if not exists su94r_labs_pid on public.su94r_labs(pid, taken_on desc);
alter table public.su94r_labs enable row level security;
revoke all on public.su94r_labs from anon, authenticated;
comment on table public.su94r_labs is 'su94r: lab results (A1c and others) typed in by the person. Service role only.';
