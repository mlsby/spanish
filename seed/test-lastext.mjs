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
const ovningsKandidater = introducerade
  .filter((id) => !kanIds.includes(id))
  .sort((a, b) => perId.get(a).minS - perId.get(b).minS);
const ovningsord = ovningsKandidater.slice(0, N_OVNING);

// ---------- ytformer ----------
const ARTIKLAR = ["el", "la", "los", "las", "un", "una", "unos", "unas"];

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
function byggVitlista() {
  const ok = new Set(ARTIKLAR);
  for (const id of introducerade) {
    const f = formById.get(id);
    if (f) {
      ok.add(f.es.toLowerCase()); // böjd verbform: exakt den mötta ytan
      continue;
    }
    const w = wordById.get(id);
    if (!w) continue;
    for (const tok of w.es.toLowerCase().split(/\s+/)) ok.add(tok);
    if (w.pos === "n" || w.pos === "adj") {
      const es = w.es.toLowerCase();
      ok.add(es + (/[aeiouáéíóú]$/.test(es) ? "s" : "es")); // regelbunden plural
      if (w.pos === "adj" && es.endsWith("o")) {
        ok.add(es.slice(0, -1) + "a");
        ok.add(es.slice(0, -1) + "as");
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
  const text = meningar.map((m) => m.es).join(" ").toLowerCase();
  const saknade = ovningsord.filter(
    (id) => !text.includes(ytform(id).toLowerCase()),
  );
  return { brott: [...brott], saknade };
}

// ---------- prompten ----------
function systemPrompt() {
  return `Du skriver pyttesmå spanska läsövningar för svenska nybörjare, i stil med graded readers.

HÅRDA REGLER:
- Använd ENDAST ord från listan TILLÅTNA ORD nedan. Inga andra ord, inga namn, inga siffertecken (skriv aldrig 1, 2, 3).
- Verb får bara användas i exakt de former som står i listan (infinitiv eller angiven böjning). Skriv hellre om med "ir a + infinitiv", "querer/poder + infinitiv" än att böja fritt.
- Substantiv och adjektiv får böjas i regelbunden plural och femininum. Artiklarna el/la/los/las/un/una är alltid tillåtna.
- Varje ÖVNINGSORD ska förekomma exakt en gång, i exakt den angivna formen, och högst ett övningsord per mening.
- Skriv exakt ${N_MENINGAR} meningar som hänger ihop till en liten vardagsscen. Enkelt, naturligt, presens.
- Max 12 ord per mening. Använd ¿…? om du ställer en fråga.

Svara i JSON: en lista "meningar" där varje element har "es" (meningen) och "ovningsord" (övningsordet som används i meningen, eller "" om inget).`;
}

function userPrompt() {
  const palett = introducerade
    .filter((id) => !ovningsord.includes(id))
    .map(visning)
    .join(", ");
  const ovn = ovningsord
    .map((id) => `${ytform(id)} (${gloss(id)})`)
    .join("\n");
  return `TILLÅTNA ORD:\n${palett}\n\nÖVNINGSORD (måste användas, exakt dessa former):\n${ovn}`;
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

console.log(`Profil: ${introducerade.length} mötta · ${kanIds.length} kan · övningsord: ${ovningsord.map(visning).join(", ")}`);

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
    ? `\n\nDitt förra försök bröt mot reglerna. Otillåtna ord: ${validera(meningar).brott.join(", ") || "-"}. Saknade övningsord: ${validera(meningar).saknade.map(ytform).join(", ") || "-"}. Skriv om och håll dig strikt till listan.`
    : "";
  const res = await client.messages.create({
    model: MODELL,
    max_tokens: 1500,
    system: systemPrompt(),
    output_config: { format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: userPrompt() + extra }],
  });
  kostnad += (res.usage.input_tokens * 3 + res.usage.output_tokens * 15) / 1e6;
  if (res.stop_reason === "refusal") {
    console.error("Modellen avböjde (refusal) — försök igen.");
    process.exit(1);
  }
  meningar = JSON.parse(res.content.find((b) => b.type === "text").text).meningar;

  const { brott, saknade } = validera(meningar);
  console.log(`\n--- försök ${forsok} ---`);
  for (const m of meningar) console.log(`  ${m.es}${m.ovningsord ? `   [${m.ovningsord}]` : ""}`);
  if (!brott.length && !saknade.length) {
    console.log(`\n✅ GODKÄND av validatorn · ~${(kostnad * 9.5 * 100).toFixed(1)} öre`);
    process.exit(0);
  }
  console.log(`❌ otillåtna: ${brott.join(", ") || "-"} · saknade övningsord: ${saknade.map(ytform).join(", ") || "-"}`);
}
console.log("\nUnderkänd efter 3 försök — hellre lucka än fel.");
process.exit(1);
