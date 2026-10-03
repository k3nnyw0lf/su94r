-- Spanish everywhere: the language of each place an alert goes, and family Telegram chats that may log.
alter table public.su94r_night
  add column if not exists lang_self text not null default 'en' check (lang_self in ('en', 'es')),
  add column if not exists lang_care text not null default 'en' check (lang_care in ('en', 'es'));
alter table public.su94r_push add column if not exists lang text not null default 'en' check (lang in ('en', 'es'));
alter table public.su94r_telegram_chats
  add column if not exists lang text not null default 'en' check (lang in ('en', 'es')),
  add column if not exists can_log boolean not null default false;
-- The doctor's link: the language its report is shown in.
alter table public.su94r_screens add column if not exists lang text check (lang in ('en', 'es'));
