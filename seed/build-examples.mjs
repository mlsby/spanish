// Exempelmeningar från Tatoeba (CC BY 2.0 FR) — en mening per ord/böjningsform.
//
//   node seed/build-examples.mjs --tatoeba <dir> [--out public/data/examples.json]
//
// <dir> ska innehålla spa_sentences.tsv, swe_sentences.tsv, spa-swe_links.tsv
// och es_50k.txt (hermitdave/FrequencyWords).
//
// Urvalsregler:
//  - meningen innehåller målordet som exakt token (accentkänsligt, gemener)
//  - 2–9 ord, 12–90 tecken, inga siffror/citat/parenteser, inga okända ord
//    (allt utom namn måste finnas i es_50k — exemplet får inte vara svårare
//    än ordet självt)
//  - poäng: max-rank bland övriga ord + längdstraff + namnstraff − svensk-bonus;
//    lägst vinner. Direkta spanska↔svenska par föredras (aldrig kedjeöversätt).
//  - ord med parentes-ledtråd (betydelsedubbletter) får bara exempel när en
//    direktlänkad svensk mening bekräftar rätt betydelse — annars ingen alls.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const DIR = opt("tatoeba");
const OUT = opt("out", "public/data/examples.json");
if (!DIR) { console.error("saknar --tatoeba <dir>"); process.exit(1); }

// ---------- ladda appdata ----------
const words = [];
for (let b = 1; b <= 5; b++) {
  const f = `public/data/batch-00${b}.json`;
  try { words.push(...JSON.parse(readFileSync(f, "utf8")).words); } catch { /* saknad batch ok */ }
}
const forms = JSON.parse(readFileSync("public/data/verbforms.json", "utf8")).forms;
console.log(`ord: ${words.length}, former: ${forms.length}`);

// svenska presensformer per moderverb — räddar betydelsekollen för verb
// ("vara" böjs till "är" i meningarna)
const svPresByParent = new Map();
for (const f of forms) {
  if (!svPresByParent.has(f.parent)) svPresByParent.set(f.parent, new Set());
  for (const w of f.svPres.split(/\s+/)) svPresByParent.get(f.parent).add(w.toLowerCase());
}

// ---------- ladda korpusar ----------
const rank = new Map();
readFileSync(join(DIR, "es_50k.txt"), "utf8").split("\n").forEach((line, i) => {
  const w = line.split(" ")[0];
  if (w && !rank.has(w)) rank.set(w, i + 1);
});

const svById = new Map();
for (const line of readFileSync(join(DIR, "swe_sentences.tsv"), "utf8").split("\n")) {
  const [id, , text] = line.split("\t");
  if (id && text) svById.set(id, text);
}
const svLink = new Map(); // spa-id → kortaste svenska meningen
for (const line of readFileSync(join(DIR, "spa-swe_links.tsv"), "utf8").split("\n")) {
  const [es, sv] = line.split("\t");
  const t = svById.get(sv?.trim());
  if (!es || !t) continue;
  const prev = svLink.get(es);
  if (!prev || t.length < prev.length) svLink.set(es, t);
}
console.log(`spanska↔svenska direktpar: ${svLink.size}`);

// ---------- mål-tokens ----------
const singleTargets = new Set(); // token → målsökning via index
const multiTargets = [];         // flerordsuttryck ("por favor") — regexmatchas
const targetOf = new Map();      // id → { needle, multi }
const addTarget = (id, es) => {
  const t = es.toLowerCase();
  if (t.includes(" ")) { multiTargets.push({ id, t }); targetOf.set(id, { needle: t, multi: true }); }
  else { singleTargets.add(t); targetOf.set(id, { needle: t, multi: false }); }
};
for (const w of words) addTarget(w.id, w.es);
for (const f of forms) addTarget(f.id, f.es);

// ---------- skanna meningarna ----------
const BAD = /[0-9"«»“”()\[\]:;/&+@_*=%$€#|~^{}]/;
const strip = (s) => s.replace(/[¿¡!?.,…'’-]/g, " ");
const cands = new Map(); // token/multi-id → [{sid,text,toks,score-delar}]
const push = (key, entry) => {
  let a = cands.get(key);
  if (!a) { a = []; cands.set(key, a); }
  if (a.length < 400) a.push(entry); // tak per mål — räcker gott för att hitta en bra
};

// homograf-vakter: "sus diferencias" (substantivläsning av verbform) och
// "sigue vivo" (adjektivläsning) ska aldrig exemplifiera ett verb
const DET = new Set([
  "el", "la", "los", "las", "un", "una", "unos", "unas", "al", "del", "cada",
  "mi", "tu", "su", "mis", "tus", "sus", "nuestro", "nuestra", "nuestros", "nuestras",
  "vuestro", "vuestra", "vuestros", "vuestras",
  "este", "esta", "estos", "estas", "ese", "esa", "esos", "esas",
  "aquel", "aquella", "aquellos", "aquellas",
]);
const ADJCTX = new Set([
  "es", "son", "era", "eran", "fue", "está", "están", "estoy", "estás",
  "sigue", "siguen", "sigo", "parece", "parecen",
  "muy", "tan", "más", "menos", "bastante", "poco", "medio", "tampoco",
]);
// böjda former står aldrig direkt efter preposition — "café de filtro" är ett substantiv
const PREPCTX = new Set(["de", "con", "sin", "en", "entre", "sobre", "hacia", "hasta", "desde", "contra", "a", "por", "para"]);
// adverb mellan kopula och mål ("está siempre lleno") avslöjas via prev2
const ADVBRIDGE = new Set(["siempre", "nunca", "ya", "aún", "todavía", "también", "casi", "tan", "muy"]);
// stavningskrock med ett basord (lleno, vivo, filtro …) ⇒ kräver otvetydig verbkontext
const SAFEVERB = new Set([
  "", "yo", "tú", "él", "ella", "usted", "nosotros", "nosotras", "ellos", "ellas", "ustedes",
  "no", "nunca", "siempre", "ya", "también", "me", "te", "se", "le", "les", "nos", "os",
  "qué", "quién", "quiénes", "cuándo", "dónde", "cómo", "y", "pero", "si", "que",
  "porque", "cuando", "mientras", "aquí", "ahora", "hoy",
]);

const lines = readFileSync(join(DIR, "spa_sentences.tsv"), "utf8").split("\n");
let scanned = 0;
for (const line of lines) {
  const [sid, , text] = line.split("\t");
  if (!sid || !text) continue;
  if (text.length < 12 || text.length > 90 || BAD.test(text)) continue;
  const rawToks = strip(text).split(/\s+/).filter(Boolean);
  if (rawToks.length < 2 || rawToks.length > 9) continue;
  const toks = rawToks.map((t) => t.toLowerCase());

  // okända ord: allt som inte är namn (versal mitt i meningen) måste finnas i es_50k
  let names = 0, unknown = false;
  for (let i = 0; i < rawToks.length; i++) {
    const lower = toks[i];
    if (rank.has(lower)) continue;
    if (i > 0 && /^[A-ZÁÉÍÓÚÑÜ]/.test(rawToks[i])) { names++; continue; } // namn ok
    unknown = true; break;
  }
  if (unknown || names > 1) continue;
  scanned++;

  const entry = { sid, text, toks, names, sv: svLink.get(sid) };
  const seen = new Set();
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!singleTargets.has(t) || seen.has(t)) continue;
    // egennamnsvakt: "San Marino" får inte exemplifiera "marino"
    if (i > 0 && rawToks[i] !== t) continue;
    seen.add(t);
    push(t, {
      ...entry,
      prev: i > 0 ? toks[i - 1] : "",
      prev2: i > 1 ? toks[i - 2] : "",
      next: i < toks.length - 1 ? toks[i + 1] : "",
    });
  }
  if (multiTargets.length) {
    const flat = ` ${toks.join(" ")} `;
    for (const m of multiTargets) {
      if (flat.includes(` ${m.t} `)) push(`multi:${m.id}`, { ...entry, prev: "" });
    }
  }
}
console.log(`användbara meningar: ${scanned}`);

// ---------- poängsätt & välj ----------
const score = (e, needle, pos) => {
  let maxOther = 0;
  for (const t of e.toks) {
    if (t === needle || needle.includes(` ${t} `) || needle.startsWith(`${t} `) || needle.endsWith(` ${t}`)) continue;
    const r = rank.get(t) ?? 0;
    if (r > maxOther) maxOther = r;
  }
  // substantiv läses tryggast med artikel framför — belöna "la casa" över "paso casa"
  const nounBonus = pos === "n" && DET.has(e.prev) ? -800 : 0;
  return maxOther + 150 * Math.abs(e.toks.length - 5) + e.names * 700 - (e.sv ? 2500 : 0) + nounBonus;
};

/** ordgränsad förekomst av svensk glosa-stam i den svenska meningen */
const svMatches = (svText, stems) => {
  const low = svText.toLowerCase();
  return [...stems].some((s) => s.length >= 2 && new RegExp(`(^|\\P{L})${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u").test(low));
};

const posByEs = new Map();
for (const w of words) if (!posByEs.has(w.es.toLowerCase())) posByEs.set(w.es.toLowerCase(), w.pos);

// alla kända verbytor (böjda + infinitiv) — substantiv efter verb är trygg läsning
const VERBSET = new Set([
  ...forms.map((f) => f.es.toLowerCase()),
  ...words.filter((w) => w.pos === "v").map((w) => w.es.toLowerCase()),
  "hay", "ha", "he", "has", "hemos", "han", "había", "habían", "hubo", "habrá",
]);
const NOUNCONJ = new Set(["y", "o", "ni", "que", "como", "más", "menos", "otra", "otro"]);
const CLITIC2 = new Set(["me", "te", "se", "nos", "os", "no", "yo", "tú", "él", "ella", "quién"]);
const QDET = new Set(["qué", "cuántas", "cuántos", "cuánta", "cuánto"]);
const formEsSet = new Set(forms.map((f) => f.es.toLowerCase()));

const ex = {};
let nWords = 0, nForms = 0, nSv = 0, nHintOk = 0, nHintSkipped = 0;
const pick = (id, hintStems, opts = {}) => {
  const tgt = targetOf.get(id);
  if (!tgt) return;
  const pool = cands.get(tgt.multi ? `multi:${id}` : tgt.needle);
  if (!pool?.length) return;
  const needle = tgt.multi ? ` ${tgt.needle} ` : tgt.needle;
  let usable = pool;
  // verbmål: kasta kandidater där formen läses som substantiv/adjektiv
  if (opts.verbish) {
    usable = usable.filter((e) => !DET.has(e.prev) && !ADJCTX.has(e.prev));
    usable = usable.filter((e) => !(ADVBRIDGE.has(e.prev) && ADJCTX.has(e.prev2)));
    // "Maduro es un hombre": två finita verb i rad är omöjligt — namnet/adjektivet avslöjas
    usable = usable.filter((e) => !formEsSet.has(e.next) && !ADJCTX.has(e.next));
  }
  if (opts.formish) usable = usable.filter((e) => !PREPCTX.has(e.prev));
  if (opts.homograph) usable = usable.filter((e) => SAFEVERB.has(e.prev));
  if (opts.pos === "n") {
    // substantivet ska stå i otvetydig substantivposition: efter artikel/preposition/
    // konjunktion eller verb — aldrig efter annat substantiv/adjektiv ("azul marino",
    // "mamífero marino") och aldrig meningsinitialt ("Sostén esto" är ett imperativ)
    usable = usable.filter((e) =>
      e.prev !== "" &&
      (DET.has(e.prev) || PREPCTX.has(e.prev) || NOUNCONJ.has(e.prev) || VERBSET.has(e.prev)) &&
      !["n", "adj"].includes(posByEs.get(e.prev) ?? ""));
    // "me las arreglo": la/lo/las/los efter pronomen är klitiker — verbläsning, inte artikel
    usable = usable.filter((e) =>
      !(["la", "lo", "las", "los"].includes(e.prev) && CLITIC2.has(e.prev2)));
    // krockar ytan med en verbform krävs artikel/preposition — verb-föregångare räcker inte
    if (formEsSet.has(tgt.needle)) {
      usable = usable.filter((e) => DET.has(e.prev) || PREPCTX.has(e.prev));
    }
  }
  // "¿Qué diferencias hay?" — qué + homografyta följd av mer sats är substantivläsning
  if (opts.homograph) {
    usable = usable.filter((e) => !(QDET.has(e.prev) && e.next !== ""));
  }
  if (hintStems) {
    // betydelsedubblett: kräver svensk mening som bekräftar rätt glosa
    usable = usable.filter((e) => e.sv && svMatches(e.sv, hintStems));
    if (!usable.length) { nHintSkipped++; return; }
    nHintOk++;
  }
  if (!usable.length) return;
  usable = [...usable].sort((a, b) => score(a, needle, opts.pos) - score(b, needle, opts.pos));
  const best = usable[0];
  ex[id] = best.sv ? [best.text, best.sv] : [best.text];
  if (best.sv) nSv++;
};

for (const w of words) {
  const stems = w.hint
    ? new Set([
        ...w.sv.toLowerCase().split(/[,\s]+/).filter((s) => s.length >= 2),
        ...(w.syn ?? []).flatMap((s) => s.toLowerCase().split(/\s+/)),
        ...(svPresByParent.get(w.id) ?? []),
      ])
    : null;
  const before = ex[w.id];
  pick(w.id, stems, { pos: w.pos, verbish: w.pos === "v" });
  if (!before && ex[w.id]) nWords++;
}
const baseEs = new Set(words.map((w) => w.es.toLowerCase()));
for (const f of forms) {
  const b = ex[f.id];
  const strict = baseEs.has(f.es.toLowerCase()) || f.person === "1s" || f.person === "2s";
  pick(f.id, null, { verbish: true, formish: true, homograph: strict });
  if (!b && ex[f.id]) nForms++;
}

// ---------- skriv ----------
const out = {
  schema: 1,
  generated: new Date().toISOString().slice(0, 10),
  attribution: ["Exempelmeningar: Tatoeba (tatoeba.org), CC BY 2.0 FR"],
  ex,
};
writeFileSync(OUT, JSON.stringify(out));
const hintWords = words.filter((w) => w.hint).length;
console.log(`exempel: ${nWords}/${words.length} ord (varav ${nHintOk}/${hintWords} ledtrådsord; ${nHintSkipped} skippade för säkerhets skull)`);
console.log(`         ${nForms}/${forms.length} former · ${nSv} med svensk översättning`);
console.log(`storlek: ${(JSON.stringify(out).length / 1024).toFixed(0)} kB → ${OUT}`);

// ---------- rapport för ögongranskning ----------
const sample = (ids, n) => ids.filter((id) => ex[id]).filter((_, i, a) => i % Math.max(1, Math.floor(a.length / n)) === 0).slice(0, n);
let md = `# Exempelmeningar — stickprov (${out.generated})\n\n| mål | mening | svensk |\n|---|---|---|\n`;
const row = (id, label) => {
  const [es, sv] = ex[id];
  md += `| ${label} | ${es} | ${sv ?? "—"} |\n`;
};
for (const id of sample(words.map((w) => w.id), 40)) row(id, id.split("|")[0]);
md += "\n## Former\n\n| mål | mening | svensk |\n|---|---|---|\n";
for (const id of sample(forms.map((f) => f.id), 25)) row(id, id.split("#")[0].split("|")[0] + "→" + forms.find((f) => f.id === id).es);
md += "\n## Ledtrådsord (betydelsekollade via svensk länk)\n\n| mål | ledtråd | mening | svensk |\n|---|---|---|---|\n";
for (const w of words.filter((w) => w.hint && ex[w.id]).slice(0, 25)) {
  const [es, sv] = ex[w.id];
  md += `| ${w.es} | ${w.hint} | ${es} | ${sv} |\n`;
}
writeFileSync("seed/report-examples.md", md);
console.log("rapport: seed/report-examples.md");
