-- Recent insulin doses shared by the Alexa skill and su94r Mini (workers/doses.js).
-- Only the su94r-cgm edge function reads or writes it, with the service-role key:
-- RLS is on with no policies, and anon/authenticated have no grants.

create table if not exists public.su94r_doses (
  id          text primary key,              -- the marker id, the same in su94r Mini
  pid         text not null,                 -- LibreLinkUp patient id
  t           timestamptz not null,          -- when the dose was taken
  kind        text not null check (kind in ('rapid', 'short', 'intermediate', 'basal', 'mix')),
  amount      numeric check (amount is null or (amount > 0 and amount <= 300)),
  source      text not null check (source in ('alexa', 'extension')),
  deleted     boolean not null default false,
  updated_at  timestamptz not null default now()
);

create index if not exists su94r_doses_pid_t on public.su94r_doses (pid, t desc);

alter table public.su94r_doses enable row level security;
revoke all on public.su94r_doses from anon, authenticated;

comment on table public.su94r_doses is 'su94r: recent insulin doses shared by the Alexa skill and su94r Mini. Service role only.';
