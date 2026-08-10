# Backlog — antecknat, inte påbörjat

Småsaker som Lucas noterat och som ska fixas vid tillfälle. Inget här är påbörjat.

## Syskonkort får inte visas rygg i rygg (antecknad 2026-08-10)

Observerat: "vad är *que*?" → svar "som" → direkt nästa kort: "hur säger man *som*?"
Samma ords två riktningar (es→sv och sv→es) hamnar intill varandra i kön, och då
är svaret på kort 2 gratis.

Tänkt fix (Ankis "bury siblings", light): när passkön byggs i `Session` — och vid
omkösning efter fel — garantera ett minsta avstånd (t.ex. ≥ 3 positioner) mellan
två kort som delar `wordId`. Om kön är för kort för att hålla avståndet (t.ex.
bara syskonen kvar på slutet) får de ligga intill — bättre än att tappa kort.
Testfall: nyintroducerade ord (båda riktningarna skapas samtidigt och hamnar
annars alltid intill varandra), omkösning via Again (+3) och korta köer.

## Övrigt öppet (sedan tidigare)

- **Brevo-SMTP felsöks**: "Error sending magic link email" vid testet — orsaken
  syns i Supabase Logs → Auth. Trolig bov: SMTP-kontot ej aktiverat hos Brevo,
  fel login-sträng, API-nyckel istället för SMTP-nyckel, eller overifierad
  avsändare. När det funkar: putsa inloggningscopyn till kod-först i `idag.ts`.
- **Migration 0002** (`supabase/migrations/20260809_0002_social.sql`) ska köras
  i SQL-editorn — Topplistan visar fel tills dess. Verifiera via REST efteråt.
- **AI-rättningsfallback** (kravspec §3 steg 3) som Supabase Edge Function;
  Claude-nyckeln som Supabase-secret, aldrig i klienten.
- **Batch 2** av ordbasen (rank 1001–2000): `node seed/build-seed.mjs` enligt
  README, granska kollisioner på samma sätt som batch 1.
