-- Medals kept once earned, per person (workers/medals.js): { "<pid>": { "range7": { "on": "2026-10-12" },
-- "week150": { "on": "…", "count": 3 } } }. Supplements, often a Fullscript plan (workers/supplements.js):
-- [{ "id", "name", "dose", "times": ["8:00"], "runsOut": "YYYY-MM-DD" | "", "fullscript": true }].
alter table public.su94r_night
  add column if not exists medals jsonb not null default '{}'::jsonb,
  add column if not exists supplements jsonb not null default '[]'::jsonb;
