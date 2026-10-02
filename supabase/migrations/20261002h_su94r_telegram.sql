-- Low alerts on Telegram (workers/telegram.js): the rebuild after the 2026-09-04 pause, with one
-- bot, its token in one place, one sender and one chat table. Service role only: RLS on, no
-- policies, no grants. The token is never returned by any route.
create table if not exists public.su94r_telegram_bot (
  id              smallint primary key default 1 check (id = 1),
  token           text not null,            -- from @BotFather, pasted by the owner into su94r Mini
  bot_username    text,
  bot_id          bigint,
  webhook_secret  text not null,            -- Telegram sends it back in X-Telegram-Bot-Api-Secret-Token
  enabled         boolean not null default true,
  updated_at      timestamptz not null default now()
);

create table if not exists public.su94r_telegram_chats (
  chat_id    bigint primary key,
  role       text not null check (role in ('me', 'family')),
  name       text,
  active     boolean not null default true,
  linked_at  timestamptz not null default now()
);

create table if not exists public.su94r_telegram_links (
  code_hash   text primary key,             -- SHA-256 of the one-time /start code
  role        text not null check (role in ('me', 'family')),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);

alter table public.su94r_telegram_bot enable row level security;
alter table public.su94r_telegram_chats enable row level security;
alter table public.su94r_telegram_links enable row level security;
revoke all on public.su94r_telegram_bot, public.su94r_telegram_chats, public.su94r_telegram_links from anon, authenticated;
comment on table public.su94r_telegram_bot is 'su94r: the one Telegram bot for low alerts (token). Service role only.';
comment on table public.su94r_telegram_chats is 'su94r: Telegram chats that linked themselves for low alerts. Service role only.';
comment on table public.su94r_telegram_links is 'su94r: one-time t.me start codes (hashes, 15 minutes). Service role only.';
