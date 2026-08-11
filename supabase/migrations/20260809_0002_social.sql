-- Glosa steg 2: det sociala lagret.
-- Körs en gång i Supabase SQL Editor (efter 0001).
-- Alla i appen är "vänner": profiler, topplistestatistik och regel-sno är
-- läsbara för alla INLOGGADE användare; skrivning är fortfarande bara egen data.

-- ---------- profiles: visningsnamn ----------
create table public.profiles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 24),
  updated_at   timestamptz not null default now()
);
alter table public.profiles enable row level security;
create policy "profiles_select_all" on public.profiles for select to authenticated using (true);
create policy "profiles_insert_own" on public.profiles for insert with check (auth.uid() = user_id);
create policy "profiles_update_own" on public.profiles for update using (auth.uid() = user_id);

-- ---------- public_stats: topplistesiffror, skrivs av ägaren själv ----------
-- (klienten räknar ut sina egna siffror ur sin data och laddar upp — enkelt
--  och gott nog för en kompisgrupp)
-- score = resapoängen: kan det + på väg (ord med minst ett svar)
create table public.public_stats (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  streak      int not null default 0,
  total_days  int not null default 0,
  score       int not null default 0,
  updated_at  timestamptz not null default now()
);
alter table public.public_stats enable row level security;
create policy "stats_select_all" on public.public_stats for select to authenticated using (true);
create policy "stats_insert_own" on public.public_stats for insert with check (auth.uid() = user_id);
create policy "stats_update_own" on public.public_stats for update using (auth.uid() = user_id);

-- ---------- rule_adoptions: "sno"-poängen ----------
-- En rad per (snoare, ord, regelägare) — dvs 1 poäng per person och ord.
create table public.rule_adoptions (
  user_id    uuid not null references auth.users(id) on delete cascade, -- den som snor
  owner_id   uuid not null references auth.users(id) on delete cascade, -- regelns ägare (får poängen)
  word_id    text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, word_id, owner_id),
  check (user_id <> owner_id)
);
alter table public.rule_adoptions enable row level security;
create policy "adoptions_select_all" on public.rule_adoptions for select to authenticated using (true);
create policy "adoptions_insert_own" on public.rule_adoptions for insert with check (auth.uid() = user_id);

-- ---------- minnesregler delas med alla inloggade ----------
-- (skrivning är oförändrat bara egen rad; anonyma ser fortfarande ingenting)
drop policy "user_words_select" on public.user_words;
create policy "user_words_select_all" on public.user_words for select to authenticated using (true);
