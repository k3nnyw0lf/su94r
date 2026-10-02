-- Doses and meals logged in the su94r phone app (workers/app.js) keep their own source.
alter table public.su94r_doses drop constraint if exists su94r_doses_source_check;
alter table public.su94r_doses add constraint su94r_doses_source_check check (source in ('alexa', 'extension', 'telegram', 'phone'));
