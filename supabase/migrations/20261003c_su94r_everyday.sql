-- Everyday: favorite meals (workers/food.js) and notes with tags (workers/notes.js), from the phone app.
create table if not exists public.su94r_meals (
  id         uuid primary key default gen_random_uuid(),
  pid        text not null,
  name       text not null check (char_length(name) between 1 and 40),
  name_key   text generated always as (lower(name)) stored,
  carbs      integer not null check (carbs between 1 and 300),
  uses       integer not null default 1,
  last_used  timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (pid, name_key)
);
alter table public.su94r_meals enable row level security;
revoke all on public.su94r_meals from anon, authenticated;
comment on table public.su94r_meals is 'su94r: favorite meals and their usual carbs. Service role only.';

create table if not exists public.su94r_notes (
  id         text primary key check (char_length(id) <= 80),
  pid        text not null,
  t          timestamptz not null,
  text       text not null default '' check (char_length(text) <= 280),
  tags       text[] not null default '{}',
  by         text not null default '' check (char_length(by) <= 40),
  deleted    boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists su94r_notes_pid_t on public.su94r_notes(pid, t desc);
alter table public.su94r_notes enable row level security;
revoke all on public.su94r_notes from anon, authenticated;
comment on table public.su94r_notes is 'su94r: notes with tags (exercise, stress, sick, ...) typed into the phone app. Service role only.';
