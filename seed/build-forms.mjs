#!/usr/bin/env node
/**
 * Bygger verbböjningsdata (fas 1: presens indikativ) för Glosa.
 *
 *   - Böjningsformer:  Fred Jehles verbdatabas (CC BY-NC-SA 3.0) för ~640
 *     vanliga verb (auktoritativ för oregelbundna), regelbunden generering
 *     för övriga bas-verb.
 *   - Urval & ranking:  hermitdave/FrequencyWords es_50k (OpenSubtitles 2018,
 *     CC BY-SA 4.0) — bara former som faktiskt förekommer i korpusen tas med,
 *     topp 4 per verb efter formens egen frekvens.
 *   - Svensk presens:   Lexin swe_spa.xml (CC BY 4.0) — uppslagsformen är
 *     presens; mappas mot vår infinitiv via samma konvertering som seedet.
 *
 * Körning:
 *   node seed/build-forms.mjs --jehle jehle_verbs.csv --es50k es_50k.txt \
 *     --lexin swe_spa.xml
 *
 * Utdata: public/data/verbforms.json + seed/report-forms.md
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];

// ---------- svensk verbmorfologi (samma som build-seed.mjs) ----------
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
    else if (t.endsWith("är")) t = t + "a";
    else if (t.endsWith("ör") && t.length >= 3) t = t + "a";
    else if (t.endsWith("yr") && t.length >= 4) t = t + "a";
    else if (/[aeiouyåäö]r$/.test(t)) t = t.slice(0, -1);
  }
  parts[0] = t;
  return parts.join(" ");
}

// ---------- basen ----------
const dataDir = join(ROOT, "public", "data");
const words = [];
for (const f of readdirSync(dataDir).sort()) {
  if (/^batch-\d+\.json$/.test(f)) words.push(...JSON.parse(readFileSync(join(dataDir, f), "utf-8")).words);
}
const verbs = words.filter((w) => w.pos === "v");
const lemmaEs = new Set(words.map((w) => w.es));
console.log(`${words.length} ord i basen, ${verbs.length} verb`);

// ---------- es_50k: rank per ytform ----------
const esRank = new Map();
readFileSync(args.es50k ?? "es_50k.txt", "utf-8").split("\n").forEach((line, i) => {
  const w = line.split(" ")[0];
  if (w && !esRank.has(w)) esRank.set(w, i + 1);
});

// ---------- Jehle: presens indikativ ----------
const PERSONS = ["1s", "2s", "3s", "1p", "3p"];
const jehle = new Map(); // infinitiv → {1s,2s,3s,1p,3p}
{
  const raw = readFileSync(args.jehle ?? "jehle_verbs.csv", "utf-8");
  // enkel CSV-parser med citattecken
  const rows = raw.split("\n").map((line) => {
    const out = []; let cur = "", q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (ch === "," && !q) { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  });
  for (const r of rows.slice(1)) {
    if (r[2] === "Indicativo" && r[4] === "Presente" && r[0]) {
      jehle.set(r[0].trim(), { "1s": r[7], "2s": r[8], "3s": r[9], "1p": r[10], "3p": r[12] });
    }
  }
  console.log(`Jehle: presens för ${jehle.size} verb`);
}

// ---------- regelbunden generering för verb utanför Jehle ----------
function regularPresent(inf) {
  const stem2 = inf.slice(0, -2);
  if (inf.endsWith("ar")) return { "1s": stem2 + "o", "2s": stem2 + "as", "3s": stem2 + "a", "1p": stem2 + "amos", "3p": stem2 + "an" };
  if (inf.endsWith("er")) return { "1s": stem2 + "o", "2s": stem2 + "es", "3s": stem2 + "e", "1p": stem2 + "emos", "3p": stem2 + "en" };
  if (inf.endsWith("ir") || inf.endsWith("ír"))
    return { "1s": stem2 + "o", "2s": stem2 + "es", "3s": stem2 + "e", "1p": stem2 + "imos", "3p": stem2 + "en" };
  return null;
}

// ---------- Lexin: svensk presens (uppslagsform) per infinitiv ----------
const svPresByInf = new Map();
{
  const xml = readFileSync(args.lexin ?? "swe_spa.xml", "utf-8");
  const re = /<Word ([^>]*)>/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    const type = (attrs.match(/Type="([^"]*)"/) || [])[1] || "";
    if (!type.startsWith("verb")) continue;
    let sv = ((attrs.match(/Value="([^"]*)"/) || [])[1] || "").replace(/\|/g, "").trim()
      .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    if (!sv || /^[A-ZÅÄÖ]/.test(sv)) continue;
    const inf = svInfinitive(sv);
    if (!svPresByInf.has(inf)) svPresByInf.set(inf, sv);
  }
  console.log(`Lexin: presens för ${svPresByInf.size} svenska infinitiv`);
}
// handlagda kompletteringar och ÖVERSTYRNINGAR (skriver över Lexin-mappen —
// "vara" måste bli "är", inte "varar")
const SV_PRES_MANUAL = {
  "vara": "är", "ha": "har", "kunna": "kan", "vilja": "vill", "veta": "vet",
  "bli": "blir", "få": "får", "gå": "går", "se": "ser", "ge": "ger", "ta": "tar",
  "göra": "gör", "säga": "säger", "komma": "kommer", "stå": "står", "dö": "dör",
  "ta itu med": "tar itu med", "laga mat": "lagar mat", "ta fel": "tar fel",
  "bete sig": "beter sig", "få plats": "får plats", "bli kär": "blir kär",
  "göra illa": "gör illa", "äta lunch": "äter lunch", "äta frukost": "äter frukost",
  "begå självmord": "begår självmord", "göra nöjd": "gör nöjd", "ta betalt": "tar betalt",
  "skynda på": "skyndar på", "nöja sig": "nöjer sig", "bli galen": "blir galen",
  "driva med": "driver med", "sticka fram": "sticker fram", "ge upphov till": "ger upphov till",
  "bli sjuk": "blir sjuk", "ge kredit": "ger kredit", "inte känna till": "känner inte till",
  "vara sugen på": "är sugen på", "bli över": "blir över", "komma överens": "kommer överens",
  "gå med på": "går med på", "ge efter": "ger efter", "dra ihop": "drar ihop",
  "rycka till sig": "rycker till sig", "gå ombord": "går ombord", "hålla fast": "håller fast",
  "bidra med": "bidrar med", "dra iväg": "drar iväg", "ta itu": "tar itu",
  "sätta eld på": "sätter eld på", "köra på": "kör på", "köra om": "kör om",
  "ställa in": "ställer in", "skriva in": "skriver in", "lösa upp": "löser upp",
  "låsa in": "låser in", "ladda ner": "laddar ner", "gå igenom": "går igenom",
  "koppla från": "kopplar från", "röra om": "rör om", "trassla till": "trasslar till",
  "ta kontakt": "tar kontakt", "flyga upp": "flyger upp", "veckla ut": "vecklar ut",
  "smutsa ner": "smutsar ner", "göra besviken": "gör besviken", "rita upp": "ritar upp",
  "sträcka ut": "sträcker ut", "hänga upp": "hänger upp", "klamra sig fast": "klamrar sig fast",
  "spela huvudrollen": "spelar huvudrollen", "slå sig ner": "slår sig ner",
  "ha premiär": "har premiär", "stå ut med": "står ut med", "ta vara på": "tar vara på",
  "ta med": "tar med", "bli kvar": "blir kvar", "vara värd": "är värd",
  "spela roll": "spelar roll", "ta ut": "tar ut", "stoppa in": "stoppar in",
  "ta bort": "tar bort", "lära ut": "lär ut", "gå ner": "går ner",
  "ta hand om": "tar hand om", "lämna tillbaka": "lämnar tillbaka", "jävlas": "jävlas",
  "följa med": "följer med", "peka på": "pekar på", "komma överens om": "kommer överens om",
  "få veta": "får veta", "stödja": "stöder", "göra ont": "gör ont",
  "tillkännage": "tillkännager", "äta middag": "äter middag", "dra tillbaka": "drar tillbaka",
  "tåla": "tål", "genomkorsa": "genomkorsar", "generera": "genererar",
  "bestå av": "består av", "detektera": "detekterar", "förolämpa": "förolämpar",
  "reta upp": "retar upp", "göra arg": "gör arg", "kräkas": "kräks",
  "kompromettera": "komprometterar", "involvera": "involverar", "härleda": "härleder",
  "centrera": "centrerar", "riva ner": "river ner", "knivhugga": "knivhugger",
  "lida av": "lider av", "presidera": "presiderar", "berusa": "berusar",
  "närma": "närmar", "formge": "formger", "tillmötesgå": "tillmötesgår",
  "förevisa": "förevisar", "huka": "hukar", "premiärvisa": "premiärvisar",
  "bli till": "blir till", "gradera": "graderar", "avsky": "avskyr",
  "översända": "översänder", "inlägga": "inlägger", "bosätta": "bosätter",
  "terrorisera": "terroriserar", "öva upp": "övar upp", "rätta till": "rättar till",
  "knäböja": "knäböjer", "hetsa upp": "hetsar upp", "kalibrera": "kalibrerar",
  "fokusera": "fokuserar", "tona bort": "tonar bort", "storma in": "stormar in",
  "återuppstå": "återuppstår", "konkretisera": "konkretiserar", "skrämmas": "skräms",
  "röra runt": "rör runt", "göra rörd": "gör rörd", "återuppta": "återupptar",
  "droga": "drogar", "halvligga": "halvligger", "avkunna dom": "avkunnar dom",
  "förskräcka": "förskräcker", "återinsätta": "återinsätter", "begå attentat": "begår attentat",
};
for (const [inf, pres] of Object.entries(SV_PRES_MANUAL)) svPresByInf.set(inf, pres); // manuellt vinner alltid

// ---------- bygg formkandidater ----------
const PRONOUN = { "1s": "jag", "2s": "du", "3s": "han/hon", "1p": "vi", "3p": "de" };
const byForm = new Map(); // esForm → [kandidater] för ambiguitetskoll
const candidates = [];
let noJehle = 0, noSvPres = [];
for (const v of verbs) {
  const paradigm = jehle.get(v.es) ?? regularPresent(v.es);
  if (!paradigm) continue;
  const fromJehle = jehle.has(v.es);
  if (!fromJehle) noJehle++;
  const svPres = svPresByInf.get(v.sv);
  if (!svPres) { noSvPres.push(`${v.id} (${v.sv})`); continue; }
  for (const p of PERSONS) {
    const es = (paradigm[p] || "").trim();
    if (!es || es.includes(" ")) continue;
    const r = esRank.get(es);
    if (!r) continue; // finns inte i korpusen → inte "vanligaste böjningarna"
    // regelbundet genererade former får inte råka vara ett annat basord (jugo-fällan)
    if (!fromJehle && lemmaEs.has(es)) continue;
    const cand = { id: `${v.id}#pres.${p}`, parent: v.id, es, person: p, svPres, r, fromJehle };
    candidates.push(cand);
    if (!byForm.has(es)) byForm.set(es, []);
    byForm.get(es).push(cand);
  }
}

// ---------- ambiguitet: samma ytform → flera verb → släpp formen ----------
const ambiguous = new Set();
for (const [es, cs] of byForm) if (new Set(cs.map((c) => c.parent)).size > 1) ambiguous.add(es);
let forms = candidates.filter((c) => !ambiguous.has(c.es));

// ---------- topp 4 per verb efter formfrekvens ----------
const byParent = new Map();
for (const f of forms) {
  if (!byParent.has(f.parent)) byParent.set(f.parent, []);
  byParent.get(f.parent).push(f);
}
forms = [];
for (const list of byParent.values()) {
  list.sort((a, b) => a.r - b.r);
  forms.push(...list.slice(0, 4));
}

// ---------- slot: var i lemma-introduktionen formen hör hemma frekvensmässigt ----------
const lemmaRanksSorted = words
  .map((w) => ({ rank: w.rank, r: esRank.get(w.es) ?? Infinity }))
  .sort((a, b) => a.rank - b.rank)
  .map((x) => x.r);
// slot = antal baslemman som är vanligare (lägre korpusrank) än formen —
// dvs. lemma-positionen där formen frekvensmässigt hör hemma i intro-kön
for (const f of forms) {
  let slot = 0;
  for (const lr of lemmaRanksSorted) if (lr <= f.r) slot++;
  f.slot = slot;
}

forms.sort((a, b) => a.r - b.r);

// ---------- sv-promptkrockar (pronomen + presens identiska för olika verb) ----------
const svPrompt = new Map();
for (const f of forms) {
  const key = `${PRONOUN[f.person]} ${f.svPres}`;
  if (!svPrompt.has(key)) svPrompt.set(key, new Set());
  svPrompt.get(key).add(f.parent);
}
const svClashes = [...svPrompt.entries()].filter(([, s]) => s.size > 1);

// ---------- utdata ----------
const out = {
  schema: 1,
  tense: "pres",
  generated: new Date().toISOString().slice(0, 10),
  attribution: [
    "Böjningsformer: Fred Jehles verbdatabas via ghidinelli/fred-jehle-spanish-verbs (CC BY-NC-SA 3.0)",
    "Formfrekvens: hermitdave/FrequencyWords es_50k (OpenSubtitles 2018, CC BY-SA 4.0)",
    "Svensk presens: Lexins svensk-spanska lexikon, Isof (CC BY 4.0)",
  ],
  forms: forms.map(({ id, parent, es, person, svPres, r, slot }) => ({ id, parent, es, person, svPres, r, slot })),
};
writeFileSync(join(dataDir, "verbforms.json"), JSON.stringify(out));

let rep = `# Formrapport (presens)\n\n${forms.length} former för ${byParent.size} verb `
  + `(${verbs.length} verb i basen; ${noJehle} utanför Jehle → regelbunden generering).\n\n`;
rep += `## Verb utan svensk presens-mappning (${noSvPres.length}) — får inga formkort\n\n${noSvPres.join(", ")}\n\n`;
rep += `## Ambiguösa former som släppts (${ambiguous.size})\n\n${[...ambiguous].join(", ")}\n\n`;
rep += `## Sv-promptkrockar (${svClashes.length}) — kontrollera att föräldrarna har hint\n\n`;
for (const [k, s] of svClashes) rep += `- "${k}": ${[...s].join(" vs ")}\n`;
rep += `\n## Topp 60 verb — granska formerna\n\n| verb | sv | former |\n|---|---|---|\n`;
const verbByRank = verbs.filter((v) => byParent.has(v.id)).sort((a, b) => a.rank - b.rank).slice(0, 60);
for (const v of verbByRank) {
  const fs = (byParent.get(v.id) ?? []).filter((f) => forms.includes(f)).sort((a, b) => a.r - b.r);
  rep += `| ${v.es} | ${v.sv} → ${fs[0]?.svPres ?? "?"} | ${fs.map((f) => `${f.es}(${f.person},#${f.r})`).join(" ")} |\n`;
}
writeFileSync(join(ROOT, "seed", "report-forms.md"), rep);
console.log(`${forms.length} former, ${byParent.size} verb → public/data/verbforms.json + seed/report-forms.md`);
console.log(`utan sv-presens: ${noSvPres.length} · ambiguösa: ${ambiguous.size} · sv-krockar: ${svClashes.length}`);
