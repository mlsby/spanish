# Research: Läsförståelse — övningsord, textlängd och progression

Underlag för läsförståelse-featuren (2026-08-11). Frågorna från Lucas:
hur många övningsord per text, ska nya ord introduceras via läsning,
hur långa texter klarar man, och när sker övergångarna?

## 1. Täckningsgrad — forskningens tydligaste siffra

Klassisk andraspråksforskning mäter läsbarhet i **lexikal täckning**: andelen
ord i texten läsaren redan kan.

- **95 %** kända ord = golvet för acceptabel förståelse (Laufer 1989; Hu & Nation 2000).
- **98 %** = tröskeln för bekväm läsning på egen hand — och den nivå som krävs
  för att man ska kunna *lära sig något av kontexten* runt de okända orden
  (Hu & Nation 2000; bekräftat i Schmitt, Jiang & Grabe 2011). En replikering
  (Kremmel m.fl. 2023) visar att skillnaden 90→98 % är gradvis snarare än en
  skarp klippa — men riktningen står sig: ju högre täckning, desto bättre.
- Graded readers (nivåanpassade böcker) läggs medvetet på ~1 okänt ord per
  20–50 löpord, dvs 2–5 % okänt.

**För Glosa:** våra "okända" är snällare än forskningens — övningsorden är
*halvkända* (påbörjade i FSRS, inte helt nya). Därför kan vi ligga i den övre
delen av spannet: **övningsord ≈ 5–10 % av löporden, resten kan-ord.**
Tumregel: **ungefär ett övningsord per mening**, aldrig två i samma mening.

## 2. Hur många övningsord per övning?

Ordinlärningsforskning brukar rekommendera 5–10 målord per lektion
(Nation 2001); arbetsminnet klarar inte att hålla många fler aktiva.
Eftersom varje övningsord dessutom blir en egen fråga efteråt sätter
frågedelen den praktiska gränsen — 8 frågor efter en text är redan ett halvt
pass.

**Rekommendation: 2–3 övningsord i de kortaste texterna, upp till 6–8 i
styckenivåerna.** Urvalet ska inte vara slumpmässigt utan FSRS-styrt: ta de
introducerade ord (och verbformer — de är egna kort) som har **lägst
retrievability just nu**, dvs de som är närmast att glömmas. Då blir varje
läsning riktad repetition i förklädnad.

## 3. Ska nya ord introduceras via läsning?

**Nej i v1.** Forskningen om incidentellt ordlärande ur läsning är samstämmig:

- Ett nytt ord behöver mötas **~8–10 gånger** i text innan det fastnar
  (Webb 2007; Pellicer-Sánchez & Schmitt 2010; spannet i litteraturen är 6–20+).
- Per genomläsning plockas bara ~1 av 12 okända ord upp (Horst, Cobb & Meara 1998).
- Avsiktligt lärande (flashcards/FSRS) är mångdubbelt effektivare för att
  etablera form–betydelse-kopplingen; läsningens styrka är **djup** —
  kollokationer, grammatik, användning.

Glosas modell (introduktion via pass + egen minnesregel) är alltså rätt väg in
för nya ord; läsningen konsoliderar. Dessutom: nya ord i texten skulle sänka
täckningen och göra texterna frustrerande. **Ev. v2-idé:** ett (1) markerat
"bonusord" med översättning som gloss, klickbar för att lägga till i kön —
glossing-forskningen (Hulstijn) stödjer det. Men inte nu.

## 4. Textlängd och progression

CEFR:s läsdeskriptorer ger skalan: A1 = enstaka korta, enkla meningar;
A2 = korta texter (~50 ord); B1 = raka sammanhängande texter (100–200 ord).
Med 100 kan-ord är paletten dessutom för liten för långa texter — längden
måste växa med ordförrådet. Vi kopplar trappan till **befintliga titlar**
(inget nytt system att lära sig):

| Titel (poäng) | Textform | Längd | Övningsord |
|---|---|---|---|
| Turista (100) | 1–2 korta meningar | 10–20 ord | 2–3 |
| Viajero (200) | 3–4 meningar | 30–45 ord | 3–4 |
| Amigo (500) | kort stycke | 60–80 ord | 4–6 |
| Vecino (1000) | helt stycke | 100–130 ord | 5–7 |
| Madrileño (2000+) | två stycken | 150–200 ord | 6–8 |

Kollen: 3 övningsord av 40 löpord = 7,5 % halvkänt, 92,5 % kan-ord — inom
spannet ovan. Övergångarna sköter sig själva när titeln stiger; upplåsning
vid **Turista (100 poäng)** enligt beslut.

## 5. Urval av ord till prompten

- **Palett:** alla kan-ord. Cap vid ~1 500 vanligaste (rank) när listan växer
  förbi det — mer ger bara längre prompt utan bättre text.
- **Övningsord:** FSRS-urval enligt §2, skickas separat märkta ("dessa MÅSTE
  användas, exakt dessa former").
- **Verbformer enligt FSRS** (Lucas krav): skör *tienes*-form ⇒ just den ytan
  ska in i texten. Kända verb får användas i infinitiv + de former användaren
  mött; prompten styr mot naturliga omskrivningar (*voy a* + infinitiv,
  *quiero* + infinitiv, *es/está* + adjektiv) — precis så skrivs riktiga
  nybörjar-graded-readers.
- **Substantiv/adjektiv:** regelbunden plural och femininum tillåts i
  validatorns vitlista (*perros*, *buena*) — det är grammatik, inte egna kort,
  och utan det blir spanskan fel. Verben hålls FSRS-strikta.

## 6. Validatorn (testet Lucas kräver)

1. Bygg vitlista av ytformer: kan-ordens es (+ artikelformer), tillåtna
   böjningar enligt §5, övningsordens exakta former, plus interpunktion/siffror.
2. Tokenisera den genererade texten; varje token utanför vitlistan ⇒ **underkänd**.
3. Kontrollera också att ALLA övningsord faktiskt förekommer.
4. Vid underkänt: regenerera (max 2 försök, skicka med felorden i prompten);
   därefter faller övningen tillbaka till "försök igen"-knapp. Hellre inget än fel.

## 7. Flödet och FSRS

Läs texten (ingen helhetsöversättning — beslut) → "Vidare till orden" →
en fråga per övningsord: **meningen visas med ordet markerat**, användaren
skriver svenskan, vanlig tolerant rättning, och svaret loggas som **riktig
FSRS-review** på ordets es→sv-kort (fel→Again, stavfel→Hard, rätt→Good — som
i passet). Att kontexten stödjer hämtningen är okej: det är fortfarande
retrieval practice, och läsning-i-kontext är själva målbeteendet.

## 8. Arkitektur (beslutad)

- **Supabase Edge Function** (`generate-text`): tar emot palett + övningsord,
  anropar Anthropic **claude-sonnet-5**, kör validatorn server- eller
  klientsidigt, returnerar text + meningarna per övningsord.
- Nyckeln läggs i **Supabase secrets** (`supabase secrets set ANTHROPIC_API_KEY=...`),
  aldrig i koden/klienten. Funktionen kräver inloggad JWT.
- Kostnad: ~1–6k tokens in + ~300 ut per text ⇒ **~5–30 öre per läsning**
  (Sonnet $3/$15 per miljon tokens; intropris $2/$10 t.o.m. aug 2026).
  En enkel taklimit (t.ex. 30 texter/användare/dag) skyddar mot slarv.

## Källor

Hu & Nation 2000 (98 %-tröskeln); Laufer 1989 (95 %); Schmitt, Jiang & Grabe
2011; Kremmel m.fl. 2023 (replikering); Nation 2001/2006; Webb 2007 samt
Hulme m.fl. 2019 (antal möten); Horst, Cobb & Meara 1998 (upptag per läsning);
Day & Bamford 1998 / Extensive Reading Foundation (graded readers); CEFR.
