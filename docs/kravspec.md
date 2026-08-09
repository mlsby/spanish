# Kravspec: Glosapp för spanska med egna minnesregler

Detta dokument är en komplett specifikation avsedd att lämnas över till en kodagent med eget GitHub-repo. Appen ska byggas från scratch. Målet är en personlig webapp där användaren (en svensktalande person) lär sig de vanligaste spanska orden genom aktiv skrivträning, FSRS-baserad spaced repetition och minnesregler som användaren själv skriver. Inga minnesregler får genereras av AI.

## 1. Syfte och omfattning

Användaren vill lära sig cirka 3 000–5 000 av de vanligaste spanska orden. Appen förhör orden i båda riktningarna (spanska→svenska och svenska→spanska), rättar skrivna svar tolerant, håller reda på exakt vilka ord användaren kan och inte kan, och tvingar fram en egenskriven minnesregel när ett ord upprepade gånger misslyckas. Appen är en mobilanpassad webapp med konto och molnlagring, deployad publikt så att användaren kan använda den från sin telefon.

## 2. Kärnflödet i ett förhörspass

Ett kort presenteras med frågesidan (t.ex. det spanska ordet). Användaren skriver sin översättning i ett textfält och trycker enter. Vid rätt svar visas facit tillsammans med eventuell sparad minnesregel i cirka 1,5 sekunder (auto-advance, med möjlighet att pausa genom att trycka på kortet), varpå nästa kort presenteras direkt. Flödet ska vara snabbt och mobile-first: det mobila skärmtangentbordets skicka-knapp rättar, textfältet behåller fokus mellan kort så att tangentbordet aldrig fälls ihop, och att gå vidare kräver ingen extra precision (stor yta eller auto-advance). På dator ska samma flöde fungera med enter, men mobilupplevelsen är den som optimeras.

Vid fel svar stannar flödet. Facit visas tydligt tillsammans med det användaren skrev. Användaren erbjuds då ett frivilligt textfält för att skriva en egen minnesregel för ordet, samt en knapp för att gå vidare utan. Om detta är ordets andra misslyckande (två lapses totalt enligt FSRS-historiken, inte nödvändigtvis i samma pass) blir minnesregelfältet obligatoriskt: användaren kan inte fortsätta passet förrän en minnesregel är ifylld för ordet. Om en minnesregel redan finns visas den vid fel, och användaren får möjlighet att redigera den; vid det obligatoriska steget räcker det att aktivt bekräfta eller redigera den befintliga regeln.

Minnesregler är fri text som användaren skriver själv. Appen får aldrig generera, föreslå eller autokomplettera minnesregler med AI.

## 3. Rättningslogik

Rättningen sker i tre steg. Steg ett är normalisering: gemener, trimmade mellanslag, och accentokänslighet i båda riktningarna (både "está/esta" och "fardaddig/färdig"-klassen av svenska tecken ska hanteras — å/ä/ö får dock inte normaliseras bort i svenska svar eftersom de är betydelsebärande; accentokänslighet gäller spanska svar, dvs á→a, é→e, í→i, ó→o, ú→u, ü→u, medan ñ inte normaliseras till n eftersom det är betydelsebärande). Steg två är fuzzy-matchning mot facit och ordets synonymlista: Damerau-Levenshtein-avstånd ≤ 1 för svar upp till 5 tecken och ≤ 2 för längre svar godkänns som stavfel. Steg tre är AI-fallback: om svaret inte matchar men ligger nära semantiskt (t.ex. användaren skriver "glad" när facit är "lycklig"), skickas ordet, facit, synonymlistan och användarens svar till en LLM-endpoint (Claude API, anropad server-side) som svarar med ett strikt JSON-beslut: korrekt eller fel, samt om svaret bör läggas till som synonym. Godkända AI-beslut cacheas genom att svaret läggs till i ordets synonymlista så att samma bedömning aldrig behöver göras två gånger. AI-fallbacken får bara triggas när steg ett och två underkänt svaret och svaret inte är tomt. Om AI-anropet misslyckas tekniskt räknas svaret som fel, med en diskret indikation att bedömningen var osäker, samt en knapp "jag hade rätt" som låter användaren manuellt rätta till bedömningen (override:en loggas och lägger till svaret som synonym).

## 4. Spaced repetition och kunskapsmodell

Schemaläggningen ska använda FSRS via det öppna biblioteket ts-fsrs med default-parametrar och retention-mål 0,90. Varje ord genererar två kort, ett per riktning, som schemaläggs oberoende av varandra men delar ordentitet, synonymlista och minnesregel. Betygssättningen mappas automatiskt från rättningen: fel svar ger Again, rätt svar med fuzzy/AI-hjälp ger Hard, exakt eller synonym-träff ger Good. Ingen manuell betygsknapp ska visas; flödet ska vara skriv-rätta-vidare.

Ett ord visas i statistiken som "Kan det" när kortets FSRS-stabilitet är minst 30 dagar. Detta är enbart en etikett: ord retireras aldrig utan fortsätter schemaläggas med allt glesare intervall. Ett misslyckande sänker stabiliteten enligt FSRS och ordet arbetar sig tillbaka. Lapse-räknaren per kort driver tvåfelsregeln i avsnitt 2.

Nya ord introduceras med en konfigurerbar dagstakt, default 10 nya ord per dag, alltid i frekvensordning. Ett pass består av alla förfallna repetitioner följt av dagens nya ord. Om användaren vill kunna köra extra pass utan nya ord ska det finnas ett "bara repetitioner"-läge.

## 5. Ordbas

Seed-datat är de 1 000 vanligaste spanska orden ur en öppen frekvenslista, förslagsvis doozan/spanish_data på GitHub (frekvenslista om 6 001 ord med engelska definitioner) eller motsvarande öppet licensierad källa. Eftersom listorna är spansk-engelska behövs ett engångssteg där svenska översättningar tas fram; detta får göras med LLM i bygget (översättning är tillåten AI-användning — förbudet gäller endast minnesregler) men ska granskas rimlighetsmässigt och lagras statiskt i databasen, inte genereras vid körning. Varje ordpost innehåller spanskt ord, svensk huvudöversättning, synonymlista på svenska, frekvensrank och ordklass. Det ska finnas ett administrativt sätt (script eller enkel adminvy) att fylla på med nästa frekvensbatch om 500–1 000 ord upp till minst 5 000 totalt, utan att röra befintlig inlärningsdata.

## 6. Konto, lagring och arkitektur

Appen ska ha konto med inloggning och all inlärningsdata i molndatabas så att den överlever byte av enhet. Förslag: Supabase med e-post/magic-link-auth, Postgres och row level security, men kodagenten får välja likvärdig stack. Datamodellen behöver i grova drag tabellerna users, words (ordbasen, delad), user_words (synonymtillägg och minnesregel per användare och ord), cards (per användare, ord och riktning: FSRS-fälten stability, difficulty, due, lapses, state) och reviews (logg över varje svar med tidsstämpel, riktning, råsvar, utfall och rättningssteg som avgjorde). Reviewloggen är viktig: den möjliggör framtida FSRS-parameteroptimering och statistik.

Frontend byggs som mobile-first SPA eller Next.js-app med svensk UI-copy, deployad på Vercel eller likvärdigt, med repot på GitHub och CI som bygger vid push. Claude-API-nyckeln för rättningsfallbacken får aldrig exponeras i klienten; AI-rättningen går genom en server-side route med rate limiting.

## 7. Statistik

Startvyn visar antal ord i kategorierna Nya, Lär mig och Kan det, antal förfallna repetitioner idag, total progression mot 5 000 ord samt en enkel graf över inlärda ord över tid baserad på reviewloggen. En ordlistevy visar alla ord med status, stabilitet och minnesregel, med sök och möjlighet att redigera minnesregel och synonymer.

## 8. Acceptanskriterier

Bygget är klart när följande gäller. Ett förhörspass går att genomföra friktionsfritt i mobilen med skärmtangentbordet, utan att tangentbordet fälls ihop mellan kort och med auto-advance vid rätt svar; på dator fungerar samma flöde med enter. Fel svar visar facit och erbjuder minnesregelfält; andra felet på samma kort blockerar fortsättning tills minnesregel finns. Rättningen godkänner accentavvikelser och enstaka stavfel, godkänner sparade synonymer, och skickar tveksamma fall till AI-fallbacken vars godkännanden sparas som synonymer. Båda riktningarna förhörs som separata FSRS-kort. Data sparas per konto i molnet och överlever utloggning och enhetsbyte. Statistiken visar korrekt antal per kategori med Kan det definierat som stabilitet ≥ 30 dagar. Nya ord introduceras i frekvensordning med konfigurerbar dagstakt. Ordbasen kan utökas i batchar utan dataförlust. Ingen del av appen genererar minnesregler med AI.

## 9. Icke-mål

Ingen AI-genererad minnesregel eller minnesbild. Inga sociala funktioner, ingen delning, ingen gamification utöver enkel statistik. Inget stöd för andra språk än spanska–svenska i första versionen, men datamodellen bör inte hårdkoda språkparet i onödan. Ingen offlinesynk i första versionen.

## 10. Öppna beslut som kodagenten får ta

Val av exakt frekvenskälla och licenskontroll av den, val av auth-leverantör och hostingdetaljer, exakt tröskel för när AI-fallbacken triggas (förslag: alltid när steg 1–2 underkänner och svaret är minst 2 tecken), samt UI-detaljer. Vid tveksamhet om produktbeslut: fråga användaren istället för att anta.
