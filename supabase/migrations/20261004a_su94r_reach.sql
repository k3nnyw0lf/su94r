-- Do alerts reach anyone (workers/coverage.js): the last alert drill and which channels answered it,
-- last night's report of lows and whether anyone answered. Phone calls for a low nobody answers
-- (workers/calls.js): on or off, and up to 4 numbers ({ name, phone (E.164), role, lang }).
alter table public.su94r_night
  add column if not exists drill jsonb not null default '{}'::jsonb,
  add column if not exists morning jsonb not null default '{}'::jsonb,
  add column if not exists call_enabled boolean not null default false,
  add column if not exists call_numbers jsonb not null default '[]'::jsonb;
