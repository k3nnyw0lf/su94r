-- The doctor's live link (workers/doctor.js): kept with the screens as kind 'doctor', with the
-- person it reports on and its expiry (expires_at).
alter table public.su94r_screens drop constraint if exists su94r_screens_kind_check;
alter table public.su94r_screens add constraint su94r_screens_kind_check check (kind in ('screen', 'widget', 'ai', 'owner', 'doctor'));
alter table public.su94r_screens add column if not exists pid text;
