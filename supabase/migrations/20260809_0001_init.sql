-- Glosa: schema för molnsynk av inlärningsdata.
-- Körs en gång i Supabase SQL Editor (eller via supabase db push).
-- All data är per användare och låst med row level security till auth.uid().

-- ---------- settings: en rad per användare ----------
create table public.settings (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  new_per_day int not null default 10,
  updated_at  timestamptz not null default now()
);
alter table public.settings enable row level security;
create policy "settings_select" on public.settings for select using (auth.uid() = user_id);
create policy "settings_insert" on public.settings for insert with check (auth.uid() = user_id);
create policy "settings_update" on public.settings for update using (auth.uid() = user_id);
create policy "settings_delete" on public.settings for delete using (auth.uid() = user_id);

-- ---------- user_words: synonymtillägg + minnesregel per ord ----------
create table public.user_words (
  user_id    uuid not null references auth.users(id) on delete cascade,
  word_id    text not null,
  syn        text[] not null default '{}',
  mnem       text not null default '',
  updated_at timestamptz not null default now(),
  primary key (user_id, word_id)
);
alter table public.user_words enable row level security;
create policy "user_words_select" on public.user_words for select using (auth.uid() = user_id);
create policy "user_words_insert" on public.user_words for insert with check (auth.uid() = user_id);
create policy "user_words_update" on public.user_words for update using (auth.uid() = user_id);
create policy "user_words_delete" on public.user_words for delete using (auth.uid() = user_id);

-- ---------- cards: ett FSRS-kort per ord och riktning ----------
create table public.cards (
  user_id       uuid not null references auth.users(id) on delete cascade,
  word_id       text not null,
  dir           text not null check (dir in ('es2sv','sv2es')),
  fsrs          jsonb not null,
  fail_count    int not null default 0,
  introduced_at timestamptz not null,
  updated_at    timestamptz not null default now(),
  primary key (user_id, word_id, dir)
);
alter table public.cards enable row level security;
create policy "cards_select" on public.cards for select using (auth.uid() = user_id);
create policy "cards_insert" on public.cards for insert with check (auth.uid() = user_id);
create policy "cards_update" on public.cards for update using (auth.uid() = user_id);
create policy "cards_delete" on public.cards for delete using (auth.uid() = user_id);

-- ---------- reviews: append-only logg över varje svar ----------
-- client_id deduplicerar vid omsynk (unik per användare).
create table public.reviews (
  id        bigint generated always as identity primary key,
  user_id   uuid not null references auth.users(id) on delete cascade,
  client_id text not null,
  ts        timestamptz not null,
  word_id   text not null,
  dir       text not null,
  raw       text not null,
  grade     text not null check (grade in ('again','hard','good')),
  step      text not null,
  unique (user_id, client_id)
);
create index reviews_user_ts on public.reviews (user_id, ts);
alter table public.reviews enable row level security;
create policy "reviews_select" on public.reviews for select using (auth.uid() = user_id);
create policy "reviews_insert" on public.reviews for insert with check (auth.uid() = user_id);

-- ---------- snapshots: dagligt statusläge för grafen ----------
create table public.snapshots (
  user_id uuid not null references auth.users(id) on delete cascade,
  day     date not null,
  kan     int not null default 0,
  lar     int not null default 0,
  primary key (user_id, day)
);
alter table public.snapshots enable row level security;
create policy "snapshots_select" on public.snapshots for select using (auth.uid() = user_id);
create policy "snapshots_insert" on public.snapshots for insert with check (auth.uid() = user_id);
create policy "snapshots_update" on public.snapshots for update using (auth.uid() = user_id);
create policy "snapshots_delete" on public.snapshots for delete using (auth.uid() = user_id);
