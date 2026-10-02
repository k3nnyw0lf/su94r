-- Health inbox, second key (workers/inbox.js): the address in the phone app can only add; the
-- collector key, held only by su94r Mini, reads and deletes. Only its hash is stored.
alter table public.su94r_inboxes add column if not exists collect_hash text;
-- The 14-day clean-up runs across all inboxes by time.
create index if not exists su94r_inbox_items_received on public.su94r_inbox_items (received_at);
