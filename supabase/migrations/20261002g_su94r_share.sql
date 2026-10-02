-- Sharing to another phone (workers/screens.js shareNew / shareClaim): a phone that opened a
-- QR code from su94r Mini is kept like a paired screen, with the role it was shared for:
-- 'me' (another phone of the owner: the owner's alert topic) or 'family' (the care topic).
alter table public.su94r_screens add column if not exists role text check (role in ('me', 'family'));
comment on column public.su94r_screens.role is 'Set for phones shared from su94r Mini by QR code: me or family.';
