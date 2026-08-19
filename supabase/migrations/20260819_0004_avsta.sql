-- Avstådda ord: "öva inte på det här ordet mer" — per ord, synkat mellan enheter.
-- Appen känner av kolumnen och synkar flaggan först när migrationen är körd.
alter table public.user_words
  add column if not exists skip boolean not null default false;
