-- Echo announcements for night lows (workers/night.js): trigger links of the free Virtual Smart
-- Home Alexa skill, each firing an Alexa routine that announces on an Echo. Private keys: stored
-- here (service role only), never returned by a route.
alter table public.su94r_night add column if not exists echo_low_url text;
alter table public.su94r_night add column if not exists echo_soon_url text;
alter table public.su94r_night add column if not exists echo_always boolean not null default false;
