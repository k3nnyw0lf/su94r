-- Health inbox (workers/inbox.js): phone apps that can only send (HC Webhook, Health Auto
-- Export, an iOS Shortcut) post to a private address; su94r Mini collects the items into the
-- health vault on the computer and the server deletes them. Only the hash of each address's
-- secret is stored. Items wait at most 14 days. Service role only: RLS on, no policies, no grants.

create table if not exists public.su94r_inboxes (
  id            uuid primary key,
  secret_hash   text not null unique,
  name          text not null default 'Phone',
  created_at    timestamptz not null default now(),
  last_post_at  timestamptz,
  revoked       boolean not null default false
);

create table if not exists public.su94r_inbox_items (
  id           bigint generated always as identity primary key,
  inbox_id     uuid not null references public.su94r_inboxes (id) on delete cascade,
  received_at  timestamptz not null default now(),
  body         jsonb not null
);

create index if not exists su94r_inbox_items_inbox on public.su94r_inbox_items (inbox_id, id);

alter table public.su94r_inboxes enable row level security;
alter table public.su94r_inbox_items enable row level security;
revoke all on public.su94r_inboxes from anon, authenticated;
revoke all on public.su94r_inbox_items from anon, authenticated;

comment on table public.su94r_inboxes is 'su94r: health inbox addresses (hashes only). Service role only.';
comment on table public.su94r_inbox_items is 'su94r: health data waiting for su94r Mini to collect (max 14 days). Service role only.';

-- AI connectors (workers/mcp.js) are kept with paired screens, as kind 'ai'.
alter table public.su94r_screens drop constraint if exists su94r_screens_kind_check;
alter table public.su94r_screens add constraint su94r_screens_kind_check check (kind in ('screen', 'widget', 'ai'));
