# Backlog

Lucas anteckningar. Överst det öppna; längst ner det som redan byggts.

## Klart (byggt 2026-08-11, släpp "exempelmeningar v2 — svensk brygga")

- **Fler svenska översättningar (Lucas: "fick aldrig se svenskan"):** utöver
  de 3 623 direkta spanska↔svenska paren används nu det engelska originalet
  som LÄNKBRYGGA (spa→eng→swe via Tatoebas länkfiler) — båda meningarna är
  människoskrivna översättningar av samma engelska mening, ingen
  maskinöversättning. 1 790 exempel har svensk översättning (818 direkta +
  972 via bryggan); i frekvensbandet 1–500 har 79 % av orden svensk mening,
  501–1000: 53 %. Längdrimlighetskoll på bryggade par.
- **Betydelselås:** en kandidatmening MED svensk översättning måste bekräfta
  målets glosa (ordets sv/synonymer/presensformer), annars förkastas den.
  Fångade "No se sienten en el sofá" (sentarse, inte sentir) och "haber
  pedido" (particip, inte substantivet). Nya vakter dessutom: "que se/me/te
  + form" (konjunktivram av annat verb), determinerare+adjektiv+mål
  ("del mismo parecer" var substantivet åsikt, inte verbet verka — Lucas
  skärmdump), haber-former borttagna ur substantivens trygga föregångare.
- *Kvar till verbfas 2:* generera konjunktivytor ur Jehle och kolla
  present-mot-konjunktiv-krockar systematiskt (sienten-klassen) redan i
  build-forms.

## Klart (byggt 2026-08-11, släpp "fortsätt övningen")

- **Avbruten övning kan fortsättas:** passet sparas lokalt på enheten efter
  varje besvarat kort (`glosa.pass.v1` — inte i molnsynken, ett halvfärdigt
  pass hör till skärmen). Avsluta, stäng appen eller ladda om — knappen blir
  "Fortsätt övningen · N kvar" (hero + passets viloläge) och återupptar med
  samma kö, ordning, räknare och prognosbaslinje. Kort som ändrats under
  pausen (t.ex. ✓-markerade till Kan det) hoppar av kön; sparningen gäller
  bara samma kalenderdag; slutförd övning rensar den. Ingen ny introduktion
  sker vid återupptagning.

## Klart (byggt 2026-08-11, släpp "exempelmeningar")

- **Exempelmeningar (Tatoeba, CC BY 2.0 FR):** en kort äkta mening per
  ord/böjningsform — 4 433/5 000 ord, 2 233/2 843 former, 1 024 med svensk
  översättning via direkta spanska↔svenska par (aldrig kedjeöversatt via
  engelska). Visas ENBART i facit-lägena (aldrig i frågan — fri återkallning
  kräver att ordet är enda ledtråden); svensk översättning bara vid
  fel/visste inte, där ingen timer stressar. Ordlistans expansion visar
  mening + översättning. Urval: max 9 ord, alla övriga ord vanligare än
  målordet (es_50k), homograf-vakter i flera lager (verbform efter
  artikel/kopula/preposition förkastas, jag/du-former kräver otvetydig
  verbkontext, substantiv kräver substantivposition, egennamn spärras,
  "Maduro es"-vakten mot två finita verb i rad). Betydelsedubbletter med
  ledtråd får bara exempel när svensk länk bekräftar glosan — 248 skippade
  hellre än fel. Pipeline: `seed/build-examples.mjs`, granskning i
  `seed/report-examples.md`, data i `public/data/examples.json` (344 kB,
  lazy-laddad). Attribution i Om Glosa + README.

## Klart (byggt 2026-08-10, släpp "en-knapps-modellen")

- **Dagens övning + Öva mer (Lucas modell):** tre knappar och en
  tempo-inställning blev EN handling. Dagens första övning = förfallna
  repetitioner + upp till **10 nya** (ställbart 0–50). Varje övning därefter
  = "Öva mer": det som förfallit + **5 nya** per omgång (ställbart 0–20,
  0 = bara repetitioner). "Första övningen" = ingen repetition loggad idag.
  Avbruten övning: osedda ord ärvs av nästa och räknas av mot målet —
  nya staplas aldrig ovanpå. Klart-skärmen har egen "Öva mer"-knapp +
  prognosrad ("~N repetitioner läggs på kommande vecka", baslinje mätt
  före introduktionen). Mjuka bromsen gäller nu alla övningar.
  Borttaget: "Bara rep.", "Plocka fler ord", turbo-läget i session.ts.
  Synk: settings-kolumnen new_per_day bär numera newFirst; newMore är
  lokal per enhet tills en migrationskolumn läggs till.

## Klart (byggt 2026-08-10, släpp "nivåstegen i ordlistan")

- **Nivåstegen (design B, Lucas val):** "Rank X" borta ur ordlistan
  (ordklassen kvar). Varje ord har en nivå beräknad ur FSRS: **Ny** (inte
  mött än — inga kort eller inget svar) · **Övar** (stabilitet < 7 d) ·
  **På gång** (7–30 d) · **Kan det** (≥ 30 d i båda riktningarna). Raden
  visar en fyrpricksstege (bärnsten/brons/grönt), expansionen en stor
  tryckbar stege: tryck på ett steg för att flytta ordet.
  - *Kan det:* ~30 d stabilitet på båda korten, kollas ärligt när kortet
    förfaller — failar man tar vanlig inlärning över (självrättande).
  - *På gång:* samma fast 14 d.
  - *Övar:* båda korten förfaller NU (läggs i dagens pass); hög stabilitet
    sänks in i bandet (max 3 d). På ett orört ord = äkta första möte i
    dagens pass (fast-track/kan redan gäller fortfarande).
  - *Ny:* nollställning med bekräftelsedialog — färska kort, ordet kommer
    som nytt i passet (radering synkar inte; färska kort gör det).
  - Bekräftelserad under stegen efter flytt ("Kan det — kollas om 30
    dagar" osv). Budget: nyskapade kort räknas som dagens introduktioner
    (samma semantik som Plocka fler); imorgon är kvoten fri.
- **Snabbmarkering (design A, Lucas val):** ✓-knapp längst ut i varje
  ordlisterad — ett tryck = Kan det (30 d, båda korten), fylld grön när
  ordet redan är där. Ångra-remsa under raden i ~6 s som återställer en
  exakt ögonblicksbild av korten (orört ord → korten tas bort helt).
  Sveppasset (B) och flervalsläget (C) valdes bort; B kan bli komplement
  senare om massgenomgången ändå känns seg.
- **Rättningsfixar:** snedstreck i facit expanderas till riktiga synonymer
  vid rättning ("han/hon är" ⇒ "han är" + "hon är" exakta; stavfel diffas
  mot närmaste variant). Formkort accepterar alla rimliga pronomen
  (han/hon/den/det, de/dom). "Jag hade rätt" på formkort sparade synonymen
  på moderverbet där formrättningen aldrig läste den — nu bor den på
  formens eget id och läses i båda riktningarna.

## Klart (byggt 2026-08-10, släpp "förkunskaper + verbböjningar")

- **Förkunskapspaketet:** exakt rätt vid ett korts allra första möte ⇒ FSRS
  Easy (dagar/veckor direkt, ingen 10-minutersvända); "kan redan — bara
  stavfel"-länk vid första mötets fuzzy-träff uppgraderar till Easy;
  syskonuppskov (andra riktningen väntar ~2 veckor som orört första möte);
  budgetåterbäring med 3×-tak (nästa enhet introduceras i bakgrunden, dyker
  upp i nästa pass); "Plocka fler"-läget ersätter +5-knappen — öppet
  introduktionspass med live-prognos ("~N rep/vecka") och mjuk broms vid
  <60 % exaktträff på sista 20.
- **Verbböjningar fas 1 (presens):** 2 843 former för 964 verb ur Jehle
  (CC BY-NC-SA) + regelbunden generering, filtrerade och rankade mot es_50k,
  svensk presens ur Lexin + 140 manuella mappningar ("vara"→"är"!). Egna
  FSRS-kort (`poder|v#pres.1s`), introduceras via korpus-slot i den förenade
  kön när moderverbet klarats en gång (max 1 form/verb/dag), delar dagsbudget.
  Prompt bär pronomenet ("jag kan" → puedo), facit bär alltid stödraden
  "av **poder** = kunna" (alla feedbacklägen), minnesregeln delas med
  moderverbet, syskonavståndet räknar per moderverb, ordlistan visar formerna
  med statusprickar under sitt verb. Tvetydiga former (creo → creer/crear)
  utelämnade; sv-promptkrockar utan hint korsaccepteras (voy/ando för "jag
  går"), med hint gäller bara egna formen (soy/estoy). Preteritum = fas 2.


## Verbböjningar fas 2 — preteritum/imperfekt (kvar)

Fas 1 (presens) är byggd. Kvar: preteritum + imperfekt som nya tempuspaket i
`build-forms.mjs` (Jehle har alla tempus), med parentesledtrådar eftersom
svenskan inte skiljer dem ("ville" = quería/quise). Imperativ & subjunktiv
väntar på meningskontext (cloze-nivå). Originalanteckningen nedan behålls som
designreferens.

## Verbböjningar (ursprunglig anteckning, fas 1 GENOMFÖRD)

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
- **Grundverb i facit på varje böjningskort — detaljerat (Lucas 2026-08-10):**
  - *Datakrav:* varje formkort bär `parentId` + etikett (tempus + person,
    t.ex. "presens · jag").
  - *Frågesidan visar ALDRIG grundverbet* — det skulle avslöja stammen
    (sv→es) eller betydelsen (es→sv). Kortets lilla etikett säger bara
    "VERB · PRESENS" — **utan person** i es→sv-riktningen, eftersom personen
    är en del av svaret ("quiero" → *jag* vill).
  - *Facit es→sv:* huvudrad **jag vill** · stödrad "av **querer** = vilja".
  - *Facit sv→es:* huvudrad **quiero** · stödrad "av **querer** = vilja".
  - *Stödraden visas i ALLA feedbacklägen* — rätt, rätt-med-stavfel, override,
    fel, tvingad minnesregel och "visste inte" (extra viktig där) — på samma
    plats som dagens hint-rad: under huvudfacit, muted, grundverbet i fet.
  - *Ordlistan:* expanderad formrad visar samma stödrad + hopp till
    moderverbets rad.
  - *Krockar inte* med alt-raden ("även rätt: …") — den gäller formens egna
    alternativ; stödraden är alltid moderverbets.
  - Kan byggas oberoende av resten av böjningspaketet och är nästan gratis.
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

## Anpassning till förkunskaper (GENOMFÖRD 2026-08-10 — behålls som referens)

Lucas: de flesta kan redan ett gäng ord — appen ska ta vara på det, utan
"vad kan du?"-enkäter. Hans hypotes: rätt svar vid *första mötet* ⇒ ordet är
nog redan känt ⇒ borde ge utrymme för fler nya ord. Föreslagen design
(tre mekanismer som samverkar, ej beslutad):

1. **Auto-fast-track (osynlig):** första recensionen någonsin på ett kort
   (reps === 0) + **exakt** rätt (inte fuzzy, inte AI) ⇒ betygsätt **Easy**
   istället för Good. ts-fsrs ger då lång startstabilitet (~2 v) istället för
   dagar — kända ord schemalägger ut sig själva ur vardagen utan något UI.
   Stavfelsrätt första gången förblir Hard (osäkert ⇒ ingen fast-track).
2. **"Kan redan"-länk EFTER svar med stavfel (Lucas ändring 2026-08-10):**
   ingen skippknapp före svaret — man skriver alltid först (produktion är
   poängen). Men vid *första mötet* + fuzzy-rätt (stavfel ⇒ normalt Hard)
   visas en länk i feedbacken: "kan redan — bara stavfel →" som uppgraderar
   betyget till **Easy** före commit (samma regrade-mekanik som "jag hade
   rätt"-overriden). Claimet är alltså alltid förankrat i bevis: du träffade
   nästan. Visas bara när reps === 0; efteråt gäller ärligt svar.
3. **Syskonuppskov vid exakt träff (Lucas 2026-08-10):** klaras första
   riktningen (es→sv) **exakt** vid första mötet introduceras andra
   riktningen INTE samma session — dess första visning skjuts ~2 veckor
   fram, fortfarande som ett orört "första möte" (inga fejkbetyg; kortet är
   New med due +14 d, så auto-Easy/kan redan-reglerna gäller när det väl
   dyker upp). Kända ord kostar därmed ETT kort nu + ett om två veckor.
   Ärlig brasklapp: es→sv-träff bevisar att man kan *betydelsen*, inte att
   man kan *producera* spanskan — men självkorrigeringen täcker det (failar
   man sv→es om två veckor startar vanlig inlärning, bara två veckor senare,
   för ett ord man bevisligen halvkan). Fuzzy/fel på första riktningen ⇒
   andra riktningen kommer samma session som vanligt.
4. **Budgetåterbäring i vanliga passet:** exakt träff på första riktningen
   vid första mötet ⇒ ordet kostar ingen introduktionsplats — nästa
   frekvensord låses upp samma dag (ingen clawback om sv→es failar senare —
   kompisnivå-ärlighet). Cap 3× dagstakten så vardagsdagen förblir
   förutsägbar; den som vill mer använder Plocka fler-läget (nedan).
5. **"Plocka fler"-läget = bonusord och turbo-onboarding i samma knapp
   (Lucas 2026-08-10: "man borde kunna gå igenom mycket snabbare om man
   verkligen vill").** Startsidans bonusknapp blir öppen istället för "+5":
   ett introduktionsläge som BARA serverar nya ord (inga repetitioner
   inblandade) i frekvensordning så länge man orkar — exakt rätt ⇒ Easy +
   syskonuppskov (punkt 3) ⇒ nästa ord direkt, stavfel ⇒ Hard + kan
   redan-länken, fel ⇒ vanlig inlärning (dyker upp i morgondagens vanliga
   pass). Ingen övre gräns: tack vare syskonuppskovet kostar ett känt ord
   ETT kort à ~5 s ⇒ 350 kända ord ≈ 30–40 min i soffan; om två veckor
   kommer sv→es-hållet som snabba första möten. Nybörjaren använder samma
   knapp för att plocka 5 extra. Skyddsräcken
   istället for tak: (a) ärlig prognosrad i läget — "det här ger ~120
   repetitioner nästa vecka" — uppdaterad live, (b) mjuk broms: om exakt-
   träffen sjunker under ~60 % på sista ~20 orden föreslår appen vänligt att
   gå tillbaka till vanlig takt (turbo är fel verktyg då), (c) avsluta när
   som helst, allt sparas per kort. Repetitionslavinen är hanterbar: kända
   ord repeteras på sekunder, FSRS-fuzz sprider förfallodagarna, och varje
   klarad recension skjuter kortet månader framåt. Mockupernas "+5
   bonusord"-copy ändras till "plocka fler ord" när startsidan byggs.

Viktiga egenskaper:
- **Självkorrigerande:** gissningsbara ord (importante) som fast-trackas fel
  åker på en lapse vid 2-veckors-recensionen och faller tillbaka i vanlig
  inlärning + tvåfelsregeln. Ingen skada skedd — bara en ärlig omväg.
- **"Kan det"-etiketten förblir förtjänad:** fast-track sätter INTE stabilitet
  ≥ 30 d direkt — den kommer när första långintervallsrecensionen klaras.
  Känt ord ⇒ "kan det" på ~2–3 veckor istället för ~2 månader.
- **Nybörjare påverkas inte alls:** utan exakta förstasvar är allt som idag.
- Passar böjningsplanen: formkort ärver samma regler (kan redan på puedo
  fast-trackar puedo, inte poder).
- Öppet: ska "kan redan" även synas i ordlistan för o-introducerade ord?
  (Lutning: nej — flödet räcker, enkäter var uttryckligen oönskade.)

## Övrigt öppet (sedan tidigare)

- **Brevo-SMTP felsöks**: "Error sending magic link email" vid testet — orsaken
  syns i Supabase Logs → Auth. Trolig bov: SMTP-kontot ej aktiverat hos Brevo,
  fel login-sträng, API-nyckel istället för SMTP-nyckel, eller overifierad
  avsändare. När det funkar: putsa inloggningscopyn till kod-först i `idag.ts`.
- **Migration 0002** (`supabase/migrations/20260809_0002_social.sql`) ska köras
  i SQL-editorn — Topplistan visar fel tills dess. Verifiera via REST efteråt.
- **PARKERAD (Lucas 2026-08-10):** AI-rättningsfallbacken (kravspec §3 steg 3)
  väntar — Lucas har fler AI-idéer och vill ta dem i ett svep senare.
  (Upplägget står fast: Supabase Edge Function, Claude-nyckeln som
  Supabase-secret, aldrig i klienten.)
- ~~Batch 2~~ **KLART 2026-08-10: hela basen utbyggd till 5 000 ord** (se Klart).

## Klart (byggt 2026-08-10, släpp "5 000 ord")

- **Ordbasen 1 000 → 5 000** i fyra nya batchar, samma granskningsdisciplin som
  batch 1: ~450 svenska dubbletter särskiljda (omdöpning till ordets egentliga
  huvudbetydelse, ledtrådar på båda, eller kors-alt för äkta synonympar där
  båda svaren räknas), ~650 luckor handöversatta, ~40 skräplemman skippade,
  ~50 felöversättningar från Lexin-inversionen rättade (moto=motorcykel,
  lámpara=lampa, cueva=grotta, raíz=rot …), 554 nya femininformer som fullt
  godkända svar, dialektpar kors-accepterade (zumo/jugo, billete/boleto,
  computadora/ordenador, aparcar/estacionar), 0 svarsläckor i ledtrådar
  verifierat maskinellt över hela basen. Progression: "5 000 i basen" = målet.

## Klart (byggt 2026-08-10, släpp "startsida A + småfixar")

- **Startsidan enligt alternativ A** ("Passet först") med Kan det-grafen
  synlig (Lucas tillägg): streakrad 🔥 med kontext, hero i KORT med synlig
  uträkning ("19 repetitioner + 14 nya ord (2 kort/ord)"), klart-läge med
  grön kvittens, "Din resa"-panel (mätare mot basen + ny/lär/kan-legend),
  kalender, graf. Konto/takt/backup/om flyttade bakom ⚙-kugghjulet.
- **+5 bonusord** (`store.introduceBonus`) — utanför dagsbudgeten, stjäl
  inte morgondagens kvot (introducedToday räknar per kalenderdag). Den
  öppna "Plocka fler"-varianten ligger kvar i förkunskapspaketet.
- **Syskonkort hålls isär** — `spaceSiblings` (≥3 positioner) när passkön
  byggs + `insertSpaced` vid omkösning efter fel; olösliga korta köer
  släpps igenom hellre än att kort tappas.
- **Stavfelsfeedback**: hard/override 2600 → 4000 ms och felstavade tecken
  markeras i facit (`diffTarget`, Levenshtein-backtrace).
- **Håll-för-paus** ersätter tap-toggle: pointerdown fryser baren, släpp
  fortsätter; `user-select/touch-callout:none` + contextmenu-skydd på
  feedbackkorten så iOS-långtryck inte öppnar delningsmenyn.
- **"Vet inte"-länk** under svarsfältet: räknas som Again, samma fel-flöde
  inkl. tvåfelsregeln, rubrik "Visste inte", ingen "du skrev"-rad, ingen
  "jag hade rätt"-länk; tomt svar + enter skakar fortfarande bara.
