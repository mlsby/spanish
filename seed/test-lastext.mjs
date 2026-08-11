// Lokal testrigg för läsförståelse-texterna: bygger palett + övningsord ur
// riktiga kort (eller simulerad profil), promptar claude-sonnet-5 och kör
// validatorn. Nyckeln läses ur ANTHROPIC_API_KEY — aldrig ur kod eller repo.
//
//   ANTHROPIC_API_KEY=... node seed/test-lastext.mjs --sim 100
//   ANTHROPIC_API_KEY=... node seed/test-lastext.mjs --kort seed/lucas-kort.json
//   node seed/test-lastext.mjs --sim 100 --torr        # visa bara prompten
//   flaggor: --meningar 3  --ord 2  --modell claude-sonnet-5
import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";

const DATA = new URL("../public/data/", import.meta.url);
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const N_MENINGAR = Number(arg("meningar", 3));
const N_OVNING = Number(arg("ord", 2));
const MODELL = arg("modell", "claude-sonnet-5");
const KNOWN_DAYS = 21;

// ---------- orddata ----------
const index = JSON.parse(readFileSync(new URL("index.json", DATA)));
const words = index.batches.flatMap(
  (b) => JSON.parse(readFileSync(new URL(b.file, DATA))).words,
);
const wordById = new Map(words.map((w) => [w.id, w]));
const forms = JSON.parse(readFileSync(new URL("verbforms.json", DATA))).forms;
const formById = new Map(forms.map((f) => [f.id, f]));

// ---------- profil: riktiga kort eller simulering ----------
function laddaKort() {
  const fil = arg("kort");
  if (fil) return JSON.parse(readFileSync(fil, "utf8"));
  const n = Number(arg("sim", 100));
  const kort = [];
  words.slice(0, n).forEach((w, i) => {
    // simulerad Turista: äldre ord sitter (25 d), nyare är sköra (0.5–6 d)
    const s = i < n * 0.6 ? 25 : 0.5 + (i % 8) * 0.8;
    for (const dir of ["es2sv", "sv2es"]) {
      kort.push({ word_id: w.id, dir, s, reps: 3 });
    }
  });
  return kort;
}

const kort = laddaKort().filter((k) => (k.reps ?? 0) > 0);
const perId = new Map();
for (const k of kort) {
  const p = perId.get(k.word_id) ?? { dirs: 0, minS: Infinity };
  p.dirs++;
  p.minS = Math.min(p.minS, k.s ?? 0);
  perId.set(k.word_id, p);
}

const introducerade = [...perId.keys()];
const kanIds = introducerade.filter((id) => {
  const p = perId.get(id);
  return p.dirs >= 2 && p.minS >= KNOWN_DAYS;
});
// Lucas idé: ge modellen dubbelt så många kandidater som målet och låt den
// välja de N som ger naturligast text — slacket köper flyt.
const ovningsKandidater = introducerade
  .filter((id) => !kanIds.includes(id))
  .sort((a, b) => perId.get(a).minS - perId.get(b).minS);
const kandidater = ovningsKandidater.slice(0, N_OVNING * 2);

// ---------- ytformer ----------
// alltid tillåten glue: artiklar + a/al/del/no — quizzas aldrig, bara bindväv
const SMAORD = ["el", "la", "los", "las", "un", "una", "unos", "unas", "a", "al", "del", "no"];

function ytform(id) {
  return formById.get(id)?.es ?? wordById.get(id)?.es ?? null;
}
function gloss(id) {
  const f = formById.get(id);
  if (f) return f.svPres;
  const w = wordById.get(id);
  return w ? w.sv : "?";
}
function visning(id) {
  const w = wordById.get(id);
  if (w?.art) return `${w.art} ${w.es}`;
  return ytform(id);
}

/** Vitlista för validatorn: tillåtna tokens i texten. */
const BOJBARA = new Set(["n", "adj", "determiner", "pron", "num"]);
function byggVitlista() {
  const ok = new Set(SMAORD);
  for (const id of introducerade) {
    const f = formById.get(id);
    if (f) {
      ok.add(f.es.toLowerCase()); // böjd verbform: exakt den mötta ytan
      continue;
    }
    const w = wordById.get(id);
    if (!w) continue;
    for (const tok of w.es.toLowerCase().split(/\s+/)) ok.add(tok);
    if (BOJBARA.has(w.pos)) {
      const es = w.es.toLowerCase();
      ok.add(es + (/[aeiouáéíóú]$/.test(es) ? "s" : "es")); // regelbunden plural
      if (es.endsWith("o")) {
        // femininum + plural: todo→toda/todos/todas, otro→otra/otros/otras
        ok.add(es.slice(0, -1) + "a");
        ok.add(es.slice(0, -1) + "as");
        ok.add(es.slice(0, -1) + "os");
      }
    }
  }
  return ok;
}

function tokenisera(text) {
  return (text.toLowerCase().match(/[a-záéíóúñü]+/g) ?? []);
}

function validera(meningar) {
  const ok = byggVitlista();
  const brott = new Set();
  for (const m of meningar) {
    for (const tok of tokenisera(m.es)) if (!ok.has(tok)) brott.add(tok);
  }
  const text = " " + meningar.map((m) => m.es).join(" ").toLowerCase() + " ";
  const anvanda = kandidater.filter((id) =>
    new RegExp(`(^|[^a-záéíóúñü])${ytform(id).toLowerCase()}([^a-záéíóúñü]|$)`).test(text),
  );
  return { brott: [...brott], anvanda, forFa: anvanda.length < N_OVNING };
}

// ---------- prompten ----------
function systemPrompt() {
  return `Du skriver pyttesmå spanska läsövningar för svenska nybörjare, i stil med graded readers.

HÅRDA REGLER:
- Använd ENDAST ord från listan TILLÅTNA ORD nedan. Inga andra ord, inga namn, inga siffertecken (skriv aldrig 1, 2, 3).
- Verb får bara användas i exakt de former som står i listan (infinitiv eller angiven böjning). Skriv hellre om med "ir a + infinitiv", "querer/poder + infinitiv" än att böja fritt.
- Substantiv, adjektiv, pronomen och determinerare får böjas i regelbunden plural och femininum (todo→todos, otro→otra).
- Alltid tillåtna småord: el, la, los, las, un, una, a, al, del, no.
- VANLIGASTE FELET är verbformer utanför listan (t.ex. "quiere" när bara "quiero" står med). Kontrollera varje verbform mot verblistan innan du svarar — skriv om med infinitivkonstruktion om formen saknas.
- Bland KANDIDATORDEN nedan: välj de ${N_OVNING} som ger den naturligaste texten och använd dem i exakt den angivna formen. Högst ett kandidatord per mening.
- Skriv ungefär ${N_MENINGAR} meningar som hänger ihop till en liten vardagsscen. Sikta på 8–10 ord per mening. Enkelt, naturligt, presens.
- Använd ¿…? om du ställer en fråga.

Svara i JSON: en lista "meningar" där varje element har "es" (meningen) och "ovningsord" (övningsordet som används i meningen, eller "" om inget).`;
}

function userPrompt() {
  // verben grupperade med sina tillåtna ytformer — tydligare karta än ordsoppa
  const verbFormer = new Map(); // lemma-id → [ytformer]
  const ovriga = [];
  for (const id of introducerade) {
    const f = formById.get(id);
    if (f) {
      const list = verbFormer.get(f.parent) ?? [];
      list.push(f.es);
      verbFormer.set(f.parent, list);
      continue;
    }
    const w = wordById.get(id);
    if (!w) continue;
    if (w.pos === "v") {
      if (!verbFormer.has(id)) verbFormer.set(id, []);
    } else {
      ovriga.push(visning(id));
    }
  }
  const verb = [...verbFormer.entries()]
    .map(([id, former]) => {
      const inf = wordById.get(id)?.es ?? id;
      return former.length ? `${inf}: ${inf}, ${former.join(", ")}` : inf;
    })
    .join(" · ");
  const kand = kandidater
    .map((id) => `${ytform(id)} (${gloss(id)})`)
    .join("\n");
  return `VERB — endast dessa former är tillåtna:\n${verb}\n\nÖVRIGA TILLÅTNA ORD:\n${ovriga.join(", ")}\n\nKANDIDATORD (välj ${N_OVNING} st, exakt dessa former):\n${kand}`;
}

// ---------- körning ----------
const schema = {
  type: "object",
  additionalProperties: false,
  required: ["meningar"],
  properties: {
    meningar: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["es", "ovningsord"],
        properties: { es: { type: "string" }, ovningsord: { type: "string" } },
      },
    },
  },
};

console.log(`Profil: ${introducerade.length} mötta · ${kanIds.length} kan · kandidater: ${kandidater.map((id) => ytform(id)).join(", ")}`);

if (flag("torr") || flag("visa-prompt")) {
  console.log("\n===== SYSTEM =====\n" + systemPrompt());
  console.log("\n===== USER =====\n" + userPrompt());
  if (flag("torr")) process.exit(0);
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("\nANTHROPIC_API_KEY saknas — kör med --torr för att se prompten.");
  process.exit(1);
}

const client = new Anthropic();
let meningar = null;
let kostnad = 0;

for (let forsok = 1; forsok <= 3; forsok++) {
  const extra = meningar
    ? `\n\nDitt förra försök bröt mot reglerna. Otillåtna ord: ${validera(meningar).brott.join(", ") || "-"}. Använda kandidatord: ${validera(meningar).anvanda.length} av minst ${N_OVNING}. Skriv om och håll dig strikt till listan.`
    : "";
  const outputConfig = { format: { type: "json_schema", schema } };
  const effort = arg("effort");
  if (effort) outputConfig.effort = effort;
  const res = await client.messages.create({
    model: MODELL,
    max_tokens: 6000,
    system: systemPrompt(),
    output_config: outputConfig,
    messages: [{ role: "user", content: userPrompt() + extra }],
  });
  kostnad += (res.usage.input_tokens * 3 + res.usage.output_tokens * 15) / 1e6;
  if (res.stop_reason === "refusal") {
    console.error("Modellen avböjde (refusal) — försök igen.");
    process.exit(1);
  }
  const textBlock = res.content.find((b) => b.type === "text");
  if (!textBlock) {
    console.error(`Inget textsvar (stop_reason: ${res.stop_reason}) — höj max_tokens?`);
    process.exit(1);
  }
  meningar = JSON.parse(textBlock.text).meningar;

  const { brott, anvanda, forFa } = validera(meningar);
  console.log(`\n--- försök ${forsok} ---`);
  for (const m of meningar) console.log(`  ${m.es}${m.ovningsord ? `   [${m.ovningsord}]` : ""}`);
  console.log(`  valda kandidater: ${anvanda.map(ytform).join(", ") || "-"}`);
  if (!brott.length && !forFa) {
    console.log(`\n✅ GODKÄND av validatorn · ~${(kostnad * 9.5 * 100).toFixed(1)} öre`);
    process.exit(0);
  }
  console.log(`❌ otillåtna: ${brott.join(", ") || "-"}${forFa ? ` · för få kandidatord (${anvanda.length}/${N_OVNING})` : ""}`);
}
console.log("\nUnderkänd efter 3 försök — hellre lucka än fel.");
process.exit(1);
