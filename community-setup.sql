-- Kriolu app — Community feature backend schema
-- Run this once in the Supabase SQL Editor (Project → SQL Editor → New query).

-- ── TABLES ──────────────────────────────────────────────
create table community_posts (
  id uuid primary key default gen_random_uuid(),
  author text not null default 'You',
  category text not null check (category in ('proverbs','music','questions','recipes')),
  body text not null check (char_length(body) between 1 and 500),
  device_id text not null,
  created_at timestamptz not null default now()
);

create table community_likes (
  post_id uuid not null references community_posts(id) on delete cascade,
  device_id text not null,
  created_at timestamptz not null default now(),
  primary key (post_id, device_id)
);

-- Reports are write-only from the client — no select policy below, so only
-- you (via the Supabase dashboard, which bypasses RLS) can see them.
create table community_reports (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references community_posts(id) on delete cascade,
  device_id text not null,
  created_at timestamptz not null default now()
);

-- ── ROW LEVEL SECURITY ──────────────────────────────────
alter table community_posts enable row level security;
alter table community_likes enable row level security;
alter table community_reports enable row level security;

create policy "public read posts" on community_posts for select using (true);
create policy "public insert posts" on community_posts for insert with check (true);

create policy "public read likes" on community_likes for select using (true);
create policy "public insert likes" on community_likes for insert with check (true);
create policy "public delete likes" on community_likes for delete using (true);

create policy "public insert reports" on community_reports for insert with check (true);

-- ── BASIC WORD FILTER (edit the `banned` array below any time) ─────────
create or replace function community_posts_filter() returns trigger as $$
declare
  banned text[] := array['badword1','badword2'];
  w text;
begin
  foreach w in array banned loop
    if position(lower(w) in lower(new.body)) > 0 then
      raise exception 'Post rejected: contains a blocked word';
    end if;
  end loop;
  return new;
end;
$$ language plpgsql;

create trigger community_posts_filter_trigger
before insert on community_posts
for each row execute function community_posts_filter();

-- ── RATE LIMIT: 1 post per 60 seconds per device ────────
create or replace function community_posts_rate_limit() returns trigger as $$
begin
  if exists (
    select 1 from community_posts
    where device_id = new.device_id
      and created_at > now() - interval '60 seconds'
  ) then
    raise exception 'Please wait a moment before posting again';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger community_posts_rate_limit_trigger
before insert on community_posts
for each row execute function community_posts_rate_limit();

-- ── REALTIME: let clients subscribe to live changes ─────
alter publication supabase_realtime add table community_posts;
alter publication supabase_realtime add table community_likes;

-- ── SEED DATA (the app's existing example posts, so it isn't empty day one) ──
insert into community_posts (author, category, body, device_id) values
  ('Ana Lima', 'proverbs', 'Kel ki bu simia, kel ki bu ta kolhe 🌱 My grandmother said this every time I complained about something. Still true.', 'seed'),
  ('Djô Sanches', 'music', 'Anyone else grow up with Cesária Évora playing every Sunday morning? Trying to find more mornas with English translations.', 'seed'),
  ('You', 'questions', 'How do you say "I miss you" properly in São Vicente Kriolu vs Santiago? Getting mixed answers from family.', 'seed');
