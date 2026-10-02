-- A family member who lives with the owner may log doses and meals from their phone (workers/app.js),
-- when the owner allows it in su94r Mini or from the owner's own phone. The owner's phone always can.
alter table public.su94r_screens add column if not exists can_log boolean not null default false;
