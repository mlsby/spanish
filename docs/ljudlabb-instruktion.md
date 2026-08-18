# Ljudlabb: kör Resemble Enhance på Language Transfer lokalt

Instruktion till en Claude-agent som kör på Lucas MacBook Pro (M3 Pro, 18 GB).
Målet: mäta hur snabbt Resemble Enhance förbättrar Language Transfer-ljud
lokalt, och producera lyssningsfiler. En molnkörning på 2 CPU-kärnor tog
**~17 min för 45 s ljud** (nfe 64, midpoint) — slå det!

## Spelregler

- Jobba i `ljudlabb/` i repo-roten. Skapa katalogen med en `.gitignore` som
  innehåller bara `*` — **inga ljudfiler, modellvikter eller venv får committas**
  (upphovsrätt + storlek). Committa ingenting alls utan att fråga.
- Ljudet är Language Transfers fria kurs — bara för privat testlyssning.
- Rör ingenting i appen (`src/`, `public/` osv.) — det här är ett fristående labb.

## 1. Setup (macOS, Apple Silicon)

```bash
brew install ffmpeg          # om den saknas
cd ljudlabb
python3.11 -m venv venv      # 3.10/3.11 — resemble-enhance trivs inte på 3.12+
./venv/bin/pip install resemble-enhance yt-dlp
```

Modellvikterna: `resemble-enhance` försöker git-klona dem och det failar ofta.
Hämta dem via HF-hubben istället och peka med `--run_dir`:

```bash
./venv/bin/python - <<'EOF'
from huggingface_hub import snapshot_download
print(snapshot_download("ResembleAI/resemble-enhance", local_dir="re-vikter"))
EOF
```

## 2. Testklippet (samma som molnreferensen)

Lektion 25 ur Complete Spanish, 45 s från 3:00:

```bash
./venv/bin/yt-dlp --playlist-items 25 -f bestaudio -o "lt25.%(ext)s" \
  "https://soundcloud.com/languagetransfer/sets/complete-spanish"
ffmpeg -y -i lt25.m4a -ss 180 -t 45 -ac 1 -ar 44100 in/lt25.wav
```

(`mkdir -p in ut-a ut-b ut-c` först.)

## 3. Körningarna — tajma varje med `time`

Prova **`--device mps`** först (Apple GPU) med fallback-flaggan satt; kraschar
den eller låter resultatet trasigt, kör om med `--device cpu` (M3-kärnorna är
snabba nog) och notera vilket som användes.

```bash
export PYTORCH_ENABLE_MPS_FALLBACK=1

# A. Default (som molnreferensen: lambd 1, tau 0.5, nfe 64, midpoint)
time ./venv/bin/resemble-enhance in ut-a --device mps --run_dir re-vikter/enhancer_stage2

# B. Tunad för brusfri källa — Lucas favoritkandidat
time ./venv/bin/resemble-enhance in ut-b --device mps --run_dir re-vikter/enhancer_stage2 --lambd 0

# C. Kvalitetsläget (dubbelt så många steg + rk4 — förvänta ~4× körtid)
time ./venv/bin/resemble-enhance in ut-c --device mps --run_dir re-vikter/enhancer_stage2 --lambd 0 --nfe 128 --solver rk4
```

## 4. Leverans

1. Konvertera resultaten till mp3 (`ffmpeg -i ut-X/lt25.wav -b:a 192k lt25-X.mp3`)
   och skicka alla tre till Lucas tillsammans med originalklippet.
2. Rapportera en liten tabell: körning, device (mps/cpu), tid i sekunder och
   realtidsfaktor (45 ÷ tiden). Jämför mot molnreferensen 17 min.
3. Om MPS funkade: extrapolera hur lång tid hela kursen (~40 h ljud) skulle ta
   med inställning B.

## Att veta

- `--lambd 0` = hoppa över denoise-steget (källan är brusfri — bara rösterna
  ska förbättras). `--tau` är rekonstruktionens "temperatur" (lägre =
  försiktigare). `--nfe`/`--solver` = kvalitet mot tid.
- Viktigt lyssningskriterium: **spanska uttal får inte förvanskas** — generativ
  enhancement kan hallucinera fonem. A/B-lyssna på de spanska fraserna.
