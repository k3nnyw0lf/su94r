-- Meals said to Alexa ("Alexa, tell my sugar I ate 40 grams") share the dose table as kind
-- 'carbs' (amount in grams), and the learner's estimate for "where am I heading" gets its own
-- small table (workers/forecast.js). Service role only, like the rest of su94r.
alter table public.su94r_doses drop constraint if exists su94r_doses_kind_check;
alter table public.su94r_doses add constraint su94r_doses_kind_check
  check (kind in ('rapid', 'short', 'intermediate', 'basal', 'mix', 'carbs'));
comment on table public.su94r_doses is 'su94r: recent insulin doses (and meals said to Alexa, kind carbs) shared by the Alexa skill and su94r Mini. Service role only.';

create table if not exists public.su94r_forecast (
  pid         text primary key,               -- LibreLinkUp patient id
  at          timestamptz not null,            -- the reading the estimate starts from
  data        jsonb not null,                  -- { trusted, mg, h30: {mg, lo, hi}, h60, horizon }
  updated_at  timestamptz not null default now()
);
alter table public.su94r_forecast enable row level security;
revoke all on public.su94r_forecast from anon, authenticated;
comment on table public.su94r_forecast is 'su94r: the learner''s latest estimate per person, sent by su94r Mini, read by Alexa. Service role only.';
