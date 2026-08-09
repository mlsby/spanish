# Glosa 🇪🇸

Personlig webapp för att lära sig de vanligaste spanska orden genom **aktiv
skrivträning**, **FSRS-baserad spaced repetition** och **egna minnesregler**
(aldrig AI-genererade). Svensk UI, mobile-first.

**Live:** https://mlsby.github.io/spanish/ · Kravspec: [docs/kravspec.md](docs/kravspec.md) ·
Designmockup: [design/mockup.html](design/mockup.html)

## Så funkar den

- Varje ord förhörs i **båda riktningarna** (spanska→svenska och svenska→spanska)
  som två oberoende FSRS-kort (ts-fsrs, default-parametrar, retention 0,90).
- Rättningen är tolerant: accentokänslig normalisering (`está`=`esta`, men `ñ`
  och `å ä ö` är betydelsebärande), artiklar och "att " krävs inte, och
  Damerau-Levenshtein ≤1/≤2 godkänner stavfel som **Hard**. Exakt/synonymträff
  ger **Good**, fel ger **Again** — inga manuella betygsknappar.
- Vid fel erbjuds ett minnesregelfält; **andra felet på samma kort gör regeln
  obligatorisk**. Minnesregler är alltid dina egna ord.
- "Jag hade rätt"-knappen sparar ditt svar som synonym (ersätter AI-fallbacken
  tills en server finns, se roadmap).
- **Kan det** = FSRS-stabilitet ≥ 30 dagar på ordets båda kort.
- 10 nya ord/dag (justerbart 0–50), alltid i frekvensordning, plus "bara
  repetitioner"-läge.

## Lagring (v1)

All inlärningsdata ligger i webbläsarens `localStorage`, bakom ett
`StorageAdapter`-gränssnitt (`src/lib/storage.ts`) så att Supabase kan kopplas
på senare utan omskrivning. **Exportera backup** från startsidan då och då —
importen återställer allt på en ny enhet.

## Utveckling

```bash
npm install
npm run dev       # dev-server
npm test          # vitest: rättningslogik + sessionsmotor
npm run build     # typecheck + produktionsbygge till dist/
```

Deploy sker automatiskt till GitHub Pages via `.github/workflows/deploy.yml`
vid push. (Om första körningen klagar på Pages: aktivera *Settings → Pages →
Source: GitHub Actions* i repot.)

## Ordbasen & seed-pipelinen

`public/data/batch-001.json` innehåller de 1 000 vanligaste orden med svensk
huvudöversättning, synonymer, ordklass, frekvensrank och artikel. Byggd av
`seed/build-seed.mjs` från öppna källor:

| Källa | Ger | Licens |
|---|---|---|
| [doozan/spanish_data](https://github.com/doozan/spanish_data) `frequency.csv` | frekvensrank + ordklass (25 002 lemman) | CC BY-SA |
| [Lexins svensk-spanska lexikon](https://sprakresurser.isof.se/lexin/spanska/) (Isof) | svenska översättningar (inverterat es→sv) | CC BY 4.0 |
| [hermitdave/FrequencyWords](https://github.com/hermitdave/FrequencyWords) `sv_full` | val av vanligaste svenska kandidat | CC BY-SA 4.0 |
| en.wiktionary via doozan `es-en.data` | genus → artikel (el/la) | CC BY-SA |

Manuella korrigeringar (~170 granskade huvudöversättningar + handöversatta
luckor + skräplemman) ligger i `seed/overrides.json` och appliceras sist.
Granskningsrapport per batch: `seed/report-NNN.md`.

### Utöka med nästa batch (utan att röra inlärningsdata)

```bash
# ladda ner källorna (görs en gång)
curl -LO https://sprakresurser.isof.se/lexin/spanska/swe_spa.xml
curl -LO https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/sv/sv_full.txt
git clone --depth 1 https://github.com/doozan/spanish_data

# bygg batch 2 (rank 1001–2000)
node seed/build-seed.mjs --to 2000 --batch 2 \
  --freq spanish_data/frequency.csv --esen spanish_data/es-en.data \
  --lexin swe_spa.xml --svfreq sv_full.txt
```

Redan utgivna ord hoppas över (id:n är stabila: `lemma|ordklass`), befintliga
batchfiler röres aldrig, och `public/data/index.json` uppdateras. Granska
rapporten, fyll luckor i `seed/overrides.json`, kör om, committa.

## Roadmap

- **Supabase**: konto (magic link), Postgres + RLS, synk av `AppData` —
  adapter-gränssnittet är förberett; reviewloggen (`reviews`) följer med för
  framtida FSRS-parameteroptimering.
- **AI-rättningsfallback** (kravspec §3 steg 3): server-side route (Supabase
  Edge Function) som frågar Claude API vid semantiskt nära svar; godkännanden
  cachas som synonymer. Kräver server — därför inte med i den statiska v1.
- Fler batchar upp till 5 000 ord.

## Attribution

Ordfrekvenser bygger på OpenSubtitles via hermitdave/FrequencyWords (CC BY-SA
4.0) och doozan/spanish_data (CC BY-SA). Svenska översättningar ur Lexins
svensk-spanska lexikon © Institutet för språk och folkminnen, CC BY 4.0.
Genus ur en.wiktionary (CC BY-SA). Ordbasfilerna i `public/data/` ärver
CC BY-SA-villkoren.
