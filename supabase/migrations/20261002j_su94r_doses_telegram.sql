-- Doses and meals logged in Telegram ("4 units rapid", "40 g", a plate photo) keep their own source.
alter table public.su94r_doses drop constraint if exists su94r_doses_source_check;
alter table public.su94r_doses add constraint su94r_doses_source_check check (source in ('alexa', 'extension', 'telegram'));
