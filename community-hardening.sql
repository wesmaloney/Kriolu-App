-- Kriolu app — community / sync hardening
-- NOT applied automatically. Review, then run once in the Supabase SQL Editor.
-- Every statement is safe to run on the live database: constraints are added
-- NOT VALID, so rows that already exist can never make them fail.

-- 1. Pin the search_path of the two trigger functions (Supabase security advisor
--    "function_search_path_mutable"). Stops a malicious schema from shadowing
--    objects the functions refer to.
alter function public.community_posts_filter()     set search_path = public, pg_temp;
alter function public.community_posts_rate_limit() set search_path = public, pg_temp;

-- 2. Bound what a client can store. The app only sends the display name and a
--    body, but the table accepts anything: a script could post a 10 MB author.
alter table community_posts
  add constraint community_posts_author_len check (char_length(author) between 1 and 40) not valid;
alter table community_posts
  add constraint community_posts_body_not_blank check (char_length(btrim(body)) > 0) not valid;
alter table community_posts
  add constraint community_posts_device_len check (char_length(device_id) between 8 and 64) not valid;
alter table community_likes
  add constraint community_likes_device_len check (char_length(device_id) between 8 and 64) not valid;
alter table community_reports
  add constraint community_reports_device_len check (char_length(device_id) between 8 and 64) not valid;

-- 3. One report per device per post (stops one device flooding the reports table).
--    If this fails with "could not create unique index", delete the duplicate
--    report rows first:
--      delete from community_reports a using community_reports b
--       where a.ctid < b.ctid and a.post_id = b.post_id and a.device_id = b.device_id;
create unique index if not exists community_reports_one_per_device
  on community_reports (post_id, device_id);

-- 4. The seed word filter still contains the placeholders 'badword1', 'badword2'.
--    Edit the array in community_posts_filter() to the words you want blocked.

-- ── Known limits, not fixable in SQL alone ─────────────────────────────────
-- * Community has no sign-in: device_id is chosen by the client, so the 60-second
--   post limit and "delete my like" can be bypassed by sending another device_id,
--   and device_id values are readable through the public likes table. The real fix
--   is to require the magic-link sign-in (already in the app for sync) to post, and
--   to key the policies on auth.uid() as user_progress already does.
-- * The anon key in index.html is meant to be public; the protection is row level
--   security, so keep RLS enabled on every table.
