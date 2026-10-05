-- The owner's doctor's MyChart and pharmacy for the phone app's Lab results card (workers/labs.js:
-- portalLinks, portalButtons). Quest, Labcorp and LibreView are built in and not stored.
-- Shape: { "mychart": { "url": "https://…" }, "pharmacy": { "id": "publix", "url": "https://…" } }.
alter table public.su94r_night
  add column if not exists portal_links jsonb not null default '{}'::jsonb;
