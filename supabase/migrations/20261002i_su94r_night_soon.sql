-- "Low soon" warnings and the sensor / signal watchdog in the night check (workers/night.js).
alter table public.su94r_night add column if not exists soon_enabled boolean not null default true;
alter table public.su94r_night add column if not exists watch_enabled boolean not null default true;
alter table public.su94r_night add column if not exists sensor_days integer not null default 14 check (sensor_days between 10 and 15);
