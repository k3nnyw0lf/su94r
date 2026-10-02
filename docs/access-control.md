# Access control

`src/lib/access.js` blocks accounts that are not on the allowlist, but only in
the UI. That code runs in the browser, so anyone who opens devtools can get past
it. It is a convenience, not a control. The real control is row-level security
(RLS) in Postgres, set up below.

## Why it matters

The Supabase anon key ships in the browser bundle. That is normal: the anon key
is designed to be public. What keeps data private is RLS on every table the key
can reach. An anon key against a table with RLS off is an open door, so check
every table before you put real data in it.

If your Supabase project also holds other apps' tables, give every su94r
function and policy a `su94r_` prefix. `create or replace function is_admin()`
on a name another app already uses replaces that app's function silently, with
no error and no undo.

---

## 1. The allowlist, in the database

A `security definer` function keeps the list in one place and the policies
readable. Replace `you@example.com` with your own sign-in address.

```sql
-- Who may use the app at all.
create or replace function public.su94r_is_allowed_user()
returns boolean language sql stable security definer set search_path = public
as $$
  select coalesce(auth.jwt() ->> 'email', '') in ('you@example.com');
$$;

-- Who may open the admin panel and read/write app_secrets.
create or replace function public.su94r_is_admin()
returns boolean language sql stable security definer set search_path = public
as $$
  select coalesce(auth.jwt() ->> 'email', '') in ('you@example.com');
$$;

revoke all on function public.su94r_is_allowed_user() from public, anon;
revoke all on function public.su94r_is_admin() from public, anon;
grant execute on function public.su94r_is_allowed_user() to authenticated;
grant execute on function public.su94r_is_admin() to authenticated;
```

Set the same addresses in `VITE_ADMIN_EMAILS` and `VITE_ALLOWED_EMAILS` at build
time so the UI and the database agree. If they disagree, the database wins.

---

## 2. Health samples

Written only by the Worker (service role, which bypasses RLS). Never written by
the browser.

```sql
alter table public.health_samples enable row level security;

drop policy if exists health_samples_read on public.health_samples;
create policy health_samples_read
  on public.health_samples
  for select
  to authenticated
  using (public.su94r_is_allowed_user());

-- No insert/update/delete policy for authenticated or anon, on purpose.
revoke all on public.health_samples from anon;
```

---

## 3. Profiles and labs

Own-row policies: each signed-in user reads and writes only their own rows.

```sql
alter table public.user_profiles enable row level security;

drop policy if exists user_profiles_own on public.user_profiles;
create policy user_profiles_own
  on public.user_profiles
  for all
  to authenticated
  using (auth.uid() = id and public.su94r_is_allowed_user())
  with check (auth.uid() = id and public.su94r_is_allowed_user());

revoke all on public.user_profiles from anon;
```

```sql
alter table public.lab_results enable row level security;

drop policy if exists lab_results_own on public.lab_results;
create policy lab_results_own
  on public.lab_results
  for all
  to authenticated
  using (auth.uid() = user_id and public.su94r_is_allowed_user())
  with check (auth.uid() = user_id and public.su94r_is_allowed_user());

revoke all on public.lab_results from anon;
```

`lab_results` is keyed on `user_id` while `user_profiles` is keyed on `id`.

---

## 4. Verify it

As an anonymous client (no session), every one of these must return zero rows
or an error:

```sql
set role anon;
select * from public.health_samples limit 1;
select * from public.user_profiles  limit 1;
select * from public.lab_results    limit 1;
reset role;
```

Then confirm the ingest endpoint rejects a bad token:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST https://<your-proxy>.workers.dev/health/ingest \
  -H 'Authorization: Bearer wrong' -d '[]'
```

Expect `401` (or `503` if the token is not set yet).

## Recommendation

Health data is best kept in a Supabase project of its own. A free-tier project
costs nothing, and one misconfigured policy can then only expose su94r's data.
