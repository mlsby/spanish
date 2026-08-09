#!/usr/bin/env node
/**
 * Bygger en ordbatch för Glosa från öppna källor:
 *
 *   - Spansk frekvens + ordklass:  doozan/spanish_data  frequency.csv  (CC BY-SA,
 *     frekvensdata ur hermitdave/FrequencyWords, OpenSubtitles)
 *   - Genus för substantiv:        doozan/spanish_data  es-en.data     (ur en.wiktionary, CC BY-SA)
 *   - Svenska översättningar:      Lexin svensk-spanskt lexikon, Institutet för språk
 *     och folkminnen (CC BY 4.0) — swe_spa.xml, inverterad es→sv
 *   - Svensk frekvens (för val av huvudöversättning): hermitdave/FrequencyWords
 *     sv_full.txt (CC BY-SA 4.0)
 *
 * Körning:
 *   node seed/build-seed.mjs --to 1000 --batch 1 \
 *     --freq /path/frequency.csv --esen /path/es-en.data \
 *     --lexin /path/swe_spa.xml --svfreq /path/sv_full.txt
 *
 * Utdata:
 *   public/data/batch-NNN.json   (orden — enda filen appen läser)
 *   public/data/index.json       (batchlista, uppdateras)
 *   seed/report-NNN.md           (luckor + stickprov för granskning)
 *
 * Manuella korrigeringar görs i seed/overrides.json och appliceras sist.
 * Nästa batch: --to 2000 --batch 2 — redan utgivna ord (id) hoppas över,
 * befintliga batchfiler röres aldrig.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------- args ----------
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
}
const TO = parseInt(args.to ?? "1000", 10);
const BATCH = parseInt(args.batch ?? "1", 10);
const FREQ = args.freq ?? "/workspace/doozan/spanish_data/frequency.csv";
const ESEN = args.esen ?? "/workspace/doozan/spanish_data/es-en.data";
const LEXIN = args.lexin ?? "swe_spa.xml";
const SVFREQ = args.svfreq ?? "sv_full.txt";

// ---------- helpers ----------
const decodeEnt = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
   .replace(/&apos;/g, "'").replace(/&amp;/g, "&");

const SKIP_POS = new Set(["none", "prop", "letter", "art", "contraction", "affix", "suffix", "prefix"]);
const SKIP_FLAGS = /NOUSAGE|DUPLICATE|PROPER/;

// doozan-pos → Lexin Type-prefix för ordklassmatchning
const POS_TO_LEXIN = {
  n: ["subst."], v: ["verb"], adj: ["adj."], adv: ["adv."],
  pron: ["pron."], prep: ["prep."], conj: ["konj."], interj: ["interj."],
  num: ["räkn."], determiner: ["pron.", "adj."], phrase: [],
};

// ---------- svenska verb: presens (Lexins uppslagsform) → infinitiv ----------
const V_EXACT = new Map(Object.entries({
  "är": "vara", "vet": "veta", "vill": "vilja", "kan": "kunna", "måste": "måste",
  "ska": "ska", "skall": "skola", "bör": "böra", "finns": "finnas", "minns": "minnas",
  "syns": "synas", "känns": "kännas", "hörs": "höras", "trivs": "trivas",
  "behövs": "behövas", "sägs": "sägas", "görs": "göras", "träffas": "träffas",
  "hoppas": "hoppas", "låtsas": "låtsas", "andas": "andas", "lyckas": "lyckas",
  "misslyckas": "misslyckas", "umgås": "umgås", "finns till": "finnas till",
  "far": "fara", "klär": "klä", "tycks": "tyckas", "synes": "synas",
  "föds": "födas", "vidkänns": "vidkännas", "gläder": "glädja", "gal": "gala",
  "stjäl": "stjäla", "beter": "bete", "heter": "heta",
}));
// oregelbundna stammar — gäller ordet självt eller efter äkta verbprefix ("förstår" → "förstå")
const V_SUFFIX = [
  ["står", "stå"], ["går", "gå"], ["slår", "slå"], ["mår", "må"], ["får", "få"],
  ["tror", "tro"], ["gror", "gro"], ["glor", "glo"], ["snor", "sno"], ["ror", "ro"],
  ["bor", "bo"], ["syr", "sy"], ["bryr", "bry"], ["gnyr", "gny"], ["flyr", "fly"],
  ["gör", "göra"], ["hör", "höra"], ["kör", "köra"], ["rör", "röra"], ["dör", "dö"],
  ["ser", "se"], ["ger", "ge"], ["ler", "le"], ["ber", "be"], ["sker", "ske"],
  ["tar", "ta"], ["drar", "dra"],
];
const V_PREFIX = /^(an|av|be|bi|bort|efter|fram|från|för|före|genom|in|kring|med|miss|mot|ned|ner|om|på|sam|till|um|und|under|upp|ur|ut|van|vid|åter|över)+$/;
function svInfinitive(word) {
  const parts = word.split(" ");
  let t = parts[0];
  if (V_EXACT.has(word)) return V_EXACT.get(word);
  if (V_EXACT.has(t)) { parts[0] = V_EXACT.get(t); return parts.join(" "); }
  let done = false;
  for (const [suf, inf] of V_SUFFIX) {
    if (t === suf || (t.endsWith(suf) && V_PREFIX.test(t.slice(0, t.length - suf.length)))) {
      t = t.slice(0, t.length - suf.length) + inf; done = true; break;
    }
  }
  if (!done) {
    if (t.endsWith("ar") && t.length >= 4) t = t.slice(0, -2) + "a";
    else if (t.endsWith("er") && t.length >= 4) t = t.slice(0, -2) + "a";
    else if (t.endsWith("är")) t = t + "a";                    // lär→lära, bär→bära, innebär→innebära
    else if (t.endsWith("ör") && t.length >= 3) t = t + "a";   // för→föra, förstör→förstöra
    else if (t.endsWith("yr") && t.length >= 4) t = t + "a";   // styr→styra
    else if (/[aeiouyåäö]r$/.test(t)) t = t.slice(0, -1);      // tror→tro, har→ha
  }
  parts[0] = t;
  return parts.join(" ");
}

// ---------- 1. frekvenslistan ----------
function loadFrequency() {
  const lines = readFileSync(FREQ, "utf-8").split("\n");
  const out = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const p = line.split(",");
    const [count, spanish, pos, flags] = [p[0], p[1], p[2], p[3]];
    if (!spanish || SKIP_POS.has(pos) || SKIP_FLAGS.test(flags || "")) continue;
    if (spanish.length < 2 && !["y", "a", "o"].includes(spanish)) continue;
    if (/^[A-ZÁÉÍÓÚÑ]/.test(spanish)) continue; // egennamn som slunkit igenom
    out.push({ es: spanish, pos, count: +count });
  }
  return out;
}

// ---------- 2. genus ur es-en.data ----------
function loadGender(wanted) {
  const gender = new Map();
  const blocks = readFileSync(ESEN, "utf-8").split("\n_____\n");
  for (const b of blocks) {
    const nl = b.indexOf("\n");
    const head = b.slice(0, nl).replace(/^_____\n/, "").trim();
    if (!wanted.has(head) || gender.has(head)) continue;
    if (!/^pos: n$/m.test(b)) continue;
    const g = b.match(/^ {2}g: ([\w; ]+)/m);
    if (g) gender.set(head, g[1].trim());
  }
  return gender;
}

// ---------- 3. svensk frekvens ----------
function loadSvFreq() {
  const rank = new Map();
  const lines = readFileSync(SVFREQ, "utf-8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const w = lines[i].split(" ")[0];
    if (w && !rank.has(w)) rank.set(w, i + 1);
  }
  return rank;
}

// ---------- 4. Lexin inverterad es→sv ----------
function cleanTranslation(t) {
  // "suscripción (a periódicos, etc.); abono (al teatro)" → ["suscripción","abono"]
  return decodeEnt(t)
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(AmLat:|abrev\.|fam\.|vulg\.|fig\.)/gi, " ")
    .split(/[;,]/)
    .map((x) => x.replace(/[¡!¿?…*]/g, "").replace(/\s+/g, " ").trim().replace(/^[.\-–]+|[.\-–]+$/g, ""))
    .filter((x) => x && x.length <= 40 && !/[:"«»0-9]/.test(x));
}

const LEXIN_SKIP_TYPE = /^(se($| )|namn|förk|förled|efterled)/;

function loadLexin() {
  const xml = readFileSync(LEXIN, "utf-8");
  const index = new Map(); // es → [{sv, type}]
  const re = /<Word ([^>]*)>([\s\S]*?)<\/Word>/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    const type = (attrs.match(/Type="([^"]*)"/) || [])[1] || "";
    let sv = decodeEnt((attrs.match(/Value="([^"]*)"/) || [])[1] || "").replace(/\|/g, "").trim();
    if (!sv || LEXIN_SKIP_TYPE.test(type)) continue;
    if (/^[A-ZÅÄÖ]/.test(sv)) continue; // egennamn/förkortningar
    if (type.startsWith("verb")) sv = svInfinitive(sv);
    const target = m[2].match(/<TargetLang>([\s\S]*?)<\/TargetLang>/);
    if (!target) continue;
    const trans = target[1].match(/<Translation>([^<]*)<\/Translation>/);
    if (!trans) continue;
    for (const es of cleanTranslation(trans[1])) {
      const key = es.toLowerCase();
      if (!index.has(key)) index.set(key, []);
      index.get(key).push({ sv, type });
    }
  }
  return index;
}

// ---------- 5. välj huvudöversättning + synonymer ----------
let svFreq = new Map();
function freqScore(sv) {
  // lägre = vanligare; flerordsuttryck straffas per extra ord
  const toks = sv.toLowerCase().split(" ");
  let worst = 0;
  for (const t of toks) worst = Math.max(worst, svFreq.get(t) ?? 400000);
  return worst + (toks.length - 1) * 25000;
}
function pickSwedish(cands, pos) {
  const wantedTypes = POS_TO_LEXIN[pos] || [];
  const posMatch = cands.filter((c) => wantedTypes.some((t) => c.type.startsWith(t)));
  const pool = posMatch.length ? posMatch : cands;
  const seen = new Set();
  const uniq = [];
  for (const c of pool) {
    const k = c.sv.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(c);
  }
  uniq.sort((a, b) => freqScore(a.sv) - freqScore(b.sv));
  return { sv: uniq[0].sv, syn: uniq.slice(1, 6).map((c) => c.sv) };
}

// ---------- kör ----------
console.log("Läser frekvenslista …");
const freq = loadFrequency();
console.log(`  ${freq.length} kandidatlemman efter filtrering`);

// redan utgivna ord (tidigare batchar) hoppas över
const dataDir = join(ROOT, "public", "data");
const published = new Set();
if (existsSync(dataDir)) {
  for (const f of readdirSync(dataDir)) {
    if (/^batch-\d+\.json$/.test(f) && f !== `batch-${String(BATCH).padStart(3, "0")}.json`) {
      for (const w of JSON.parse(readFileSync(join(dataDir, f), "utf-8")).words) published.add(w.id);
    }
  }
}
console.log(`  ${published.size} ord redan utgivna i tidigare batchar`);

const overridesPathEarly = join(ROOT, "seed", "overrides.json");
const overridesEarly = existsSync(overridesPathEarly) ? JSON.parse(readFileSync(overridesPathEarly, "utf-8")) : {};

const accepted = [];
for (const row of freq) {
  const id = `${row.es}|${row.pos}`;
  if (published.has(id)) continue;
  if (overridesEarly[id]?.skip) continue; // skräplemman utesluts, nästa frekvensord fyller på
  accepted.push({ ...row, id });
  if (accepted.length + published.size >= TO) break;
}

console.log("Läser svensk frekvens …");
svFreq = loadSvFreq();
console.log(`  ${svFreq.size} svenska former`);

console.log("Läser Lexin …");
const lexin = loadLexin();
console.log(`  ${lexin.size} spanska nycklar i inverterat index`);

console.log("Läser genus …");
const gender = loadGender(new Set(accepted.filter((w) => w.pos === "n").map((w) => w.es)));
console.log(`  genus för ${gender.size} substantiv`);

const overrides = overridesEarly;

const words = [];
let rank = published.size;
for (const row of accepted) {
  rank += 1;
  const cands = lexin.get(row.es.toLowerCase()) || [];
  let sv = "", syn = [];
  if (cands.length) ({ sv, syn } = pickSwedish(cands, row.pos));
  const w = { id: row.id, rank, es: row.es, pos: row.pos, sv, syn };
  if (row.pos === "n") {
    const g = gender.get(row.es);
    if (g === "f") w.art = "la";
    else if (g && /^m/.test(g)) w.art = "el";
  }
  const ov = overrides[row.id];
  if (ov) {
    if (ov.sv) w.sv = ov.sv;
    if (ov.syn) w.syn = ov.syn;
    else if (ov.addSyn) w.syn = [...new Set([...w.syn, ...ov.addSyn])];
    if (ov.art !== undefined) { if (ov.art) w.art = ov.art; else delete w.art; }
    if (ov.pos) w.pos = ov.pos; // endast visning — id:t behåller ursprunglig pos
    w.src = "manuell";
  }
  words.push(w);
}

const remaining = words.filter((w) => !w.sv);
console.log(`\n${words.length} ord · ${remaining.length} utan översättning (luckor)`);

// ---------- utdata ----------
const batchName = `batch-${String(BATCH).padStart(3, "0")}.json`;
const batchJson = {
  schema: 1,
  batch: BATCH,
  generated: new Date().toISOString().slice(0, 10),
  attribution: [
    "Frekvens & ordklass: doozan/spanish_data (CC BY-SA), frekvensdata ur hermitdave/FrequencyWords (OpenSubtitles, CC BY-SA 4.0)",
    "Svenska översättningar: Lexins svensk-spanska lexikon, Institutet för språk och folkminnen (CC BY 4.0)",
    "Genus: en.wiktionary via doozan/spanish_data es-en.data (CC BY-SA)",
  ],
  words,
};
writeFileSync(join(dataDir, batchName), JSON.stringify(batchJson));

const index = { schema: 1, batches: [] };
for (const f of readdirSync(dataDir).sort()) {
  if (/^batch-\d+\.json$/.test(f)) {
    const j = JSON.parse(readFileSync(join(dataDir, f), "utf-8"));
    index.batches.push({ file: f, batch: j.batch, count: j.words.length });
  }
}
index.total = index.batches.reduce((a, b) => a + b.count, 0);
writeFileSync(join(dataDir, "index.json"), JSON.stringify(index));

// granskningsrapport
let report = `# Seedrapport batch ${BATCH}\n\n${words.length} ord, rank ${words[0]?.rank}–${words.at(-1)?.rank}.\n\n`;
report += `## Luckor utan översättning (${remaining.length}) — fyll i seed/overrides.json\n\n`;
for (const w of remaining) report += `- \`${w.id}\` (rank ${w.rank}, ${w.pos})\n`;
report += `\n## Alla ord — granska rimlighet\n\n| rank | es | pos | sv | synonymer |\n|---|---|---|---|---|\n`;
for (const w of words) {
  report += `| ${w.rank} | ${w.art ? w.art + " " : ""}${w.es} | ${w.pos} | ${w.sv}${w.src ? " ✎" : ""} | ${w.syn.join(", ")} |\n`;
}
writeFileSync(join(ROOT, "seed", `report-${String(BATCH).padStart(3, "0")}.md`), report);
console.log(`Skrev public/data/${batchName}, public/data/index.json och seed/report-${String(BATCH).padStart(3, "0")}.md`);
