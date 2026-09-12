-- Kriolu app — account & cloud sync backend schema
-- Already run against https://icnbwjbcpjonzbuyhqvm.supabase.co this session.
-- Kept here for reference / to reproduce on a fresh project.

-- One row per signed-in user, holding the exact same JSON blob the app
-- already writes to localStorage — this piggybacks on the app's existing
-- state shape instead of redesigning it into a normalised schema.
create table user_progress (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state text not null,
  updated_at timestamptz not null default now()
);

alter table user_progress enable row level security;

-- Unlike the Community tables (no login, so RLS could only check a
-- client-supplied device_id), these policies check auth.uid() — the
-- verified identity from the user's own session — so nobody can read or
-- overwrite another account's progress.
create policy "own row select" on user_progress for select using (auth.uid() = user_id);
create policy "own row insert" on user_progress for insert with check (auth.uid() = user_id);
create policy "own row update" on user_progress for update using (auth.uid() = user_id);

-- Auth configuration done via the dashboard (Authentication → URL
-- Configuration), not SQL:
--   Site URL:      https://aesthetic-centaur-b6af6f.netlify.app
--   Redirect URLs: https://aesthetic-centaur-b6af6f.netlify.app/**
--                  http://localhost:8743/**  (local testing)
-- Email provider was already enabled by default — signInWithOtp() (magic
-- link) needs no further provider setup.
