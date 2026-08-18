-- Lyssna: kursposition och spelade lektioner, synkat mellan enheter.
-- Rad med lektion = 0 är en pekare: pos = numret på senast aktiva lektionen.
create table if not exists public.lyssna (
  user_id uuid not null references auth.users(id) on delete cascade,
  lektion int not null,
  pos int not null default 0,
  spelad boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, lektion)
);
alter table public.lyssna enable row level security;
create policy "lyssna_egna_rader" on public.lyssna for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
