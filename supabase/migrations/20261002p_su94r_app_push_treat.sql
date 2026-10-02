-- Low alerts that ring in the su94r phone app (workers/webpush.js), and the low treatment timer
-- (app/treat in workers/app.js, recheck in workers/night.js).

-- The server's own VAPID key pair, made the first time a phone asks. Service role only; the
-- private key never leaves the server.
create table if not exists public.su94r_push_key (
  id          int primary key default 1 check (id = 1),
  public_key  text not null,
  private_jwk jsonb not null,
  created_at  timestamptz not null default now()
);
alter table public.su94r_push_key enable row level security;
revoke all on public.su94r_push_key from anon, authenticated;
comment on table public.su94r_push_key is 'su94r: VAPID key pair for app alerts. Service role only.';

-- A phone's push subscription, tied to its linked-phone row (removed with it).
create table if not exists public.su94r_push (
  id          uuid primary key default gen_random_uuid(),
  screen_id   text not null references public.su94r_screens(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  failures    int not null default 0,
  last_ok_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists su94r_push_screen on public.su94r_push(screen_id);
alter table public.su94r_push enable row level security;
revoke all on public.su94r_push from anon, authenticated;
comment on table public.su94r_push is 'su94r: phones that get low alerts in the app (web push). Service role only.';

-- The owner's low plan: grams to log with one tap, minutes until the recheck, and their own words.
alter table public.su94r_night
  add column if not exists treat_grams int not null default 15,
  add column if not exists treat_minutes int not null default 15,
  add column if not exists treat_plan text;
