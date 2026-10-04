-- Safety: exercise and sick-day modes (they end by themselves at mode_until), the emergency card's
-- details, and the emergency card's link (kind 'emergency' in su94r_screens, hash only).
alter table public.su94r_night
  add column if not exists mode text check (mode in ('exercise', 'sick')),
  add column if not exists mode_until timestamptz,
  add column if not exists emergency jsonb not null default '{}'::jsonb;
alter table public.su94r_screens drop constraint if exists su94r_screens_kind_check;
alter table public.su94r_screens add constraint su94r_screens_kind_check
  check (kind in ('screen', 'widget', 'ai', 'owner', 'doctor', 'emergency'));
