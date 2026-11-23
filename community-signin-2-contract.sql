-- Kriolu app — community sign-in, step 2 of 2: CONTRACT (run AFTER the app update is live)
--
-- From here on posting, liking and reporting need a signed-in (email-verified) account:
-- the anonymous policies are removed and every write is tied to auth.uid(). Reading the
-- feed stays public. device_id is kept (now optional) so older app versions still load.
--
-- Anonymous likes and reports cannot be tied to an account, so they are removed. Posts
-- written before sign-in existed stay, with no owner.

-- ── Posts ──────────────────────────────────────────────────────────────
drop policy if exists "public insert posts" on public.community_posts;
alter table public.community_posts alter column device_id drop not null;
create policy "signed-in users post" on public.community_posts for insert to authenticated
  with check (
    user_id = auth.uid()
    and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false   -- an email account, not an anonymous session
  );

-- One post per minute per ACCOUNT (it used to be per device, which anyone could change)
create or replace function public.community_posts_rate_limit() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if exists (
    select 1 from public.community_posts
    where user_id = new.user_id
      and created_at > now() - interval '60 seconds'
  ) then
    raise exception 'Please wait a moment before posting again';
  end if;
  return new;
end;
$$;

-- ── Likes: one per account per post ────────────────────────────────────
drop policy if exists "public insert likes" on public.community_likes;
drop policy if exists "public delete likes" on public.community_likes;
delete from public.community_likes where user_id is null;
alter table public.community_likes drop constraint if exists community_likes_pkey;   -- it was (post_id, device_id)
alter table public.community_likes alter column user_id set not null;
alter table public.community_likes alter column device_id drop not null;
alter table public.community_likes add primary key (post_id, user_id);
create policy "signed-in users like" on public.community_likes for insert to authenticated
  with check (user_id = auth.uid() and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false);
create policy "users remove their own likes" on public.community_likes for delete to authenticated
  using (user_id = auth.uid());

-- ── Reports: one per account per post ──────────────────────────────────
drop policy if exists "public insert reports" on public.community_reports;
drop index if exists public.community_reports_one_per_device;
delete from public.community_reports where user_id is null;
alter table public.community_reports alter column user_id set not null;
alter table public.community_reports alter column device_id drop not null;
create unique index if not exists community_reports_one_per_user on public.community_reports (post_id, user_id);
create policy "signed-in users report" on public.community_reports for insert to authenticated
  with check (user_id = auth.uid() and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false);

-- Reports stay write-only for everyone: still no select policy, so only the dashboard sees them.
