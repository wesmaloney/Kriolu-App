-- Kriolu app — community sign-in, step 1 of 2: EXPAND (safe to run before the app update)
--
-- Adds a user_id to posts, likes and reports. It is filled in automatically for
-- signed-in users (default auth.uid()) and stays empty for anonymous requests, so the
-- current app keeps working exactly as before and the new app can already use it.
-- Nothing is removed or tightened here; that is step 2, run after the new app is live.

alter table public.community_posts
  add column if not exists user_id uuid default auth.uid() references auth.users(id) on delete set null;
alter table public.community_likes
  add column if not exists user_id uuid default auth.uid() references auth.users(id) on delete cascade;
alter table public.community_reports
  add column if not exists user_id uuid default auth.uid() references auth.users(id) on delete cascade;

create index if not exists community_posts_user_idx   on public.community_posts (user_id);
create index if not exists community_likes_user_idx   on public.community_likes (user_id);
create index if not exists community_reports_user_idx on public.community_reports (user_id);
