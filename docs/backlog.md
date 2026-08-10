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

## Hemskärmen görs om (antecknad 2026-08-10)

1. **Siffrorna går inte ihop.** Heron visar `due + newAvailable` — men `due` är
   *kort* och `newAvailable` är *ord*, och varje nytt ord blir två kort. Lucas
   såg "33" på hemskärmen och "47 kort kvar" i passet (19 rep + 14 nya ord →
   19 + 28 kort). Fix: räkna kort överallt och visa uträkningen öppet, t.ex.
   "19 repetitioner + 14 nya ord (28 kort)". Gäller även knappen
   "Bara repetitioner (N)" — den är redan i kort, behåll.
2. **Bonusord.** Man ska alltid kunna plocka fler nya ord utöver dagstakten
   (t.ex. "+5 bonusord" när dagens nya är slut). Obs: `introduceToday()` är
   idempotent per dag via `introducedToday()` — bonus behöver ett eget API som
   medvetet går förbi dagsbudgeten, annars äter bonusorden morgondagens kvot
   på andra enheter efter synk (eller tvärtom). Bestäm: ska bonus räknas in i
   `introducedToday` (bonus idag = färre imorgon) eller inte? Luta åt *inte* —
   bonus ska kännas gratis.
3. **Allmän logiköversyn av Idag-fliken** — ordning och hierarki (vad är
   handling, vad är statistik). Mockupförslag finns i `design/startsida.html`:
   A Passet först · B Checklistan · C Kalendern främst · D Ringen — alla med
   kort-räkning, bonusord, streak på startsidan och ⚙ för konto/inställningar.
   Väntar på Lucas val (eller mix).

## Feedback-vyn: längre visning vid stavfel + håll-för-paus (antecknad 2026-08-10)

1. **Rätt-med-stavfel ska visas längre.** Idag: good 1500 ms, hard/override
   2600 ms (`AUTO_MS` i `pass.ts`) — hard är alltså redan längre, men inte
   tillräckligt. Förslag: hard/override ≈ 4000 ms, och markera själva stavfelet
   visuellt (t.ex. rätt stavning med de avvikande tecknen betonade) så att den
   extra tiden faktiskt används till att se vad som blev fel.
2. **Håll in kortet för att pausa.** Idag finns tap-toggle ("tryck för paus")
   och nedräkningsbaren fryser redan via `.card.paused .cdbar
   {animation-play-state:paused}`. Ändra interaktionen till *håll*: pointerdown
   på kortet → paus så länge fingret ligger kvar, pointerup → fortsätt.
   Fällor: kortets befintliga pointerdown-hanterare (keepFocus, preventDefault)
   ska samsas med detta; iOS långtryck behöver `-webkit-touch-callout:none` +
   `user-select:none` på kortet i feedbacklägena så inte textmarkering/
   delningsmenyn triggas; behåll Enter-för-nästa.

## "Vet inte" i passet (antecknad 2026-08-10)

Man måste kunna ge upp ett kort utan att hitta på ett svar — idag är enda
vägen att medvetet skriva fel (tomt svar skakar bara). Diskret **"vet inte"**-
länk under svarsfältet, med samma pointerdown/preventDefault-knep som övriga
knappar så tangentbordet inte fälls ihop. Beteende: räknas som Again och går
in i **exakt samma fel-flöde** som ett felsvar (facit, minnesregel,
tvåfelsregeln, omkösning +3) — men utan "du skrev"-raden, och med rubriken
"Visste inte" istället för "Fel". Tomt svar + enter ska *fortsätta* skaka —
bara den explicita länken betyder "vet inte", annars kostar en slarv-enter
ett kort. Mockup: sista sektionen i `design/startsida.html`.

## Verbböjningar (antecknad 2026-08-10) — störst av backlogpunkterna

> **Research klar (2026-08-10):** se `docs/research-bojningar.md`. Kortversion:
> formkort har direkt vetenskapligt stöd (formfrekvens > lemmafrekvens, snål
> transfer mellan former), presens först (~40 % av verbanvändningen) sedan
> preteritum, interleava introduktionen (max 1–2 former/verb/dag), imperativ &
> subjunktiv väntar på meningskontext. Ingen mainstream-app gör detta fullt ut.

Lucas idé, tre delar: (1) de vanligaste böjningarna ska förhöras, (2) när ett
nytt verb introduceras kommer böjningarna i vettig ordning (jag-formen först
osv.), (3) verbets grundform ska alltid stå med i facit.

Tänkt upplägg:
- **Böjningskort = egna FSRS-kort** knutna till moderverbet (`poder#pres.1sg`
  e.d.), båda riktningarna som vanligt. Svenskan böjs inte efter person, så
  promten bär pronomenet: "jag kan" → *puedo*, "vi kan" → *podemos* — det gör
  sv→es-riktningen entydig på köpet.
- **Urval per verb = verklig korpusfrekvens**, inte hela paradigmet: ta verbets
  former ur morfologikällan (doozan/es-wiktionary-datat) × hermitdaves
  es-frekvenser och plocka topp ~4–6 (presens först; preteritum/imperfekt
  som senare påfyllnad). "Vanligaste böjningarna" blir då bokstavligt sant.
- **Formlistan hittad & verifierad (2026-08-10):**
  `hermitdave/FrequencyWords` → `content/2018/es/es_50k.txt` (finns även
  `es_full.txt` för längre svans). Ren ytformslista ur OpenSubtitles 2018 —
  samma korpusfamilj som både doozans lemmalista och vår svenska ranking, så
  registret (talspråk) blir konsekvent. Licens: MIT för koden,
  **CC BY-SA 4.0 för innehållet** — samma attributionsmodell vi redan har i
  "Om Glosa". Kvitto på Lucas poäng: *puedo* #65, *puede* #83, *puedes* #119,
  *podría* #153, *podemos* #182, *pueden* #289 — alla vanligare än
  grundformen *poder* på #362.
- **Introduktionsordning:** grundformen först; när den suttit (t.ex. första
  rätta svaret) släpps böjningarna in några i taget — jag-formen först funkar
  fint pedagogiskt (och är oftast ändå bland de frekventaste), sen 3:e person
  sing. som är spanskans arbetshäst.
- **Grundform i facit, alltid:** på böjningskortens feedback en stödrad i stil
  med "*puedo* → jag kan · av **poder** = kunna". (Kan byggas oberoende av
  resten och är nästan gratis.)
- **Minnesregeln delas med moderverbet** — regeln för poder gäller alla former
  (tvåfelsregeln räknas per kort som vanligt). Rimligt? Lucas bekräftar.
- **Öppet beslut:** ska böjningskort äta av samma dagsbudget som nya ord, eller
  ha egen takt? Lutning: samma budget (annars exploderar dagarna), men det
  saktar ner nya ord — värt att känna på.
- Kollisionsmaskineriet (hints/disambig) återanvänds när former krockar
  ("kan" utan pronomen, är/es-klassikern osv.).
- **Introduktionsmodell (skiss 2026-08-10):** en enda intro-kö sorterad på
  verklig korpusfrekvens — lemman med sin aggregerade siffra, böjningar med
  sin egen (tengo 954k slår de flesta substantiv). Ovanpå kön tre spärrar:
  (1) en form låses upp först när moderverbets grundform besvarats rätt en
  gång, (2) max 1–2 nya former per verb och dag — forskningens interleaving,
  (3) syskonregeln utökas till "delar moderverb" så puedo/poder/puede hålls
  isär i passkön. Dagsbudgeten delas (8 ord + 6 böjningar = 14), heron visar
  uppdelningen. Vid lansering på befintligt konto: redan introducerade verbs
  toppformer låses upp direkt och dominerar kön några veckor (lätta poäng,
  throttlat av budgeten). Preteritum/imperfekt behöver parentesledtrådar
  eftersom svenskan inte skiljer dem ("ville" = quería/quise) — fas 2.

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
