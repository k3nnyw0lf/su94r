-- Connecting su94r Mini to its server (workers/owner.js): the LibreLinkUp account the server
-- belongs to and the newest LibreLinkUp session su94r Mini handed over (so the server needs no
-- stored password). One row. Service role only: RLS on, no policies, no grants.
create table if not exists public.su94r_owner (
  id          smallint primary key default 1 check (id = 1),
  account_id  text not null,
  session     jsonb,
  updated_at  timestamptz not null default now()
);
alter table public.su94r_owner enable row level security;
revoke all on public.su94r_owner from anon, authenticated;
comment on table public.su94r_owner is 'su94r: the LibreLinkUp account this server belongs to and its handed-over session. Service role only.';

-- su94r Mini's own key after connecting is kept with paired screens, as kind 'owner'.
alter table public.su94r_screens drop constraint if exists su94r_screens_kind_check;
alter table public.su94r_screens add constraint su94r_screens_kind_check check (kind in ('screen', 'widget', 'ai', 'owner'));
