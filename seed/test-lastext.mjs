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
const lasFormer = new Map(Object.entries(JSON.parse(readFileSync(new URL("verbforms.json", DATA))).las ?? {}));

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
  .filter((id) => !formById.has(id)) // böjningsformer quizzas i passet, inte här
  .filter((id) => !kanIds.includes(id))
  .sort((a, b) => perId.get(a).minS - perId.get(b).minS);
const kandidater = ovningsKandidater.slice(0, N_OVNING * 3);
const kandSet = new Set(kandidater);
// tre nivåer i prompten: KAN (sitter), NÄSTAN KAN (mött men vinglar), KANDIDATER
const kanSet = new Set(kanIds);
const blanda = (a) => {
  const x = [...a];
  for (let i = x.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [x[i], x[j]] = [x[j], x[i]];
  }
  return x;
};

// ---------- ytformer ----------
// alltid tillåten glue: artiklar + a/al/del/no + es/está/hay — quizzas aldrig, bara bindväv
const SMAORD = [
  "el", "la", "los", "las", "un", "una", "unos", "unas", "a", "al", "del", "no",
  "es", "son", "está", "están", "hay",
  // vanliga förnamn — fria historier namnger sina karaktärer
  "juan", "maría", "ana", "pedro", "luis", "carmen", "sofía", "carlos", "lucía",
  "miguel", "elena", "pablo", "marta", "diego", "rosa", "david", "laura", "josé",
  "clara", "antonio",
];
// mött verb ⇒ alla dess presensformer får läsas (samma expansion som i appen)
const formsByParent = new Map();
for (const f of forms) {
  const list = formsByParent.get(f.parent) ?? [];
  list.push(f);
  formsByParent.set(f.parent, list);
}

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
  const verbIds = new Set();
  for (const id of introducerade) {
    const f = formById.get(id);
    if (f) {
      ok.add(f.es.toLowerCase());
      ok.add((wordById.get(f.parent)?.es ?? "").toLowerCase());
      verbIds.add(f.parent);
      continue;
    }
    const w = wordById.get(id);
    if (!w) continue;
    if (w.pos === "v") verbIds.add(id);
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
  for (const id of verbIds) {
    const las = lasFormer.get(id) ?? (formsByParent.get(id) ?? []).map((f) => f.es);
    for (const e of las) ok.add(e.toLowerCase());
  }
  ok.delete("");
  return ok;
}

function tokenisera(text) {
  return (text.toLowerCase().match(/[a-záéíóúñü]+/g) ?? []);
}

/** Kandidatens godtagbara ytor: grundformen + (för verb) dess presensformer. */
function ytorFor(id) {
  const w = wordById.get(id);
  const ytor = [ytform(id)];
  if (w?.pos === "v") ytor.push(...(lasFormer.get(id) ?? []));
  return ytor.filter(Boolean);
}

function validera(meningar, deklarerade = []) {
  const ok = byggVitlista();
  const extra = kopplaDeklarerade(deklarerade);
  const tillat = new Set([...extra.values()].flat());
  const brott = new Set();
  for (const m of meningar) {
    for (const tok of tokenisera(m)) if (!ok.has(tok) && !tillat.has(tok)) brott.add(tok);
  }
  const text = " " + meningar.join(" ").toLowerCase() + " ";
  const finns = (y) =>
    new RegExp(`(^|[^a-záéíóúñü])${y.toLowerCase()}([^a-záéíóúñü]|$)`).test(text);
  // formacceptans: kandidatverbet räknas i valfri egen form + deklarerade böjningar
  const anvanda = kandidater.filter((id) =>
    [...ytorFor(id), ...(extra.get(id) ?? [])].some(finns));
  return { brott: [...brott], anvanda, forFa: anvanda.length < ORD_LO };
}

// ---------- prompten (speglar lasPrompt i appen — EN text) ----------
const ORD_LO = Math.min(N_OVNING, Math.max(2, N_OVNING - 2));

function heleprompten() {
  const menLo = Math.max(2, N_MENINGAR - 1);
  const spann = ORD_LO === N_OVNING ? `${N_OVNING}` : `${ORD_LO}–${N_OVNING}`;
  return `Skriv en kort text på enkel spanska för en svensk som lär sig språket: ${menLo}–${N_MENINGAR} meningar som hänger ihop — en liten historia, en konversation eller en blandning, det som blir mest levande.

Använd orden i KAN-listan och väv in ${spann} av KANDIDATORDEN — inte fler, läsaren förhörs på dem efter läsningen. NÄSTAN KAN-orden finns om flytet kräver dem. Alltid ok är el, la, los, las, un, una, a, al, del, no, es, son, está, están, hay, regelbunden plural och femininum samt vanliga spanska förnamn. Alla andra ord är förbjudna — ett okänt ord och läsaren tappar tråden.

Verb använder du helst i formerna som står i parentes. Behöver berättelsen en annan böjning av ett kandidatord går det bra — men håll det på en nivå du tror att läsaren förstår.

Titeln skrivs på svenska: talande, sätter scenen, står fri från ordlistorna. Avslöja bara inte kandidatordens betydelser — läsaren förhörs på dem efteråt.

${ordlistor()}

## Svarsformat

JSON med fyra fält: "titelSv" (titeln), "text" (hela texten på spanska), "textSv" (samma text på naturlig svenska — samma meningar i samma ordning), "kandidatord" (de kandidatord du använde, i exakt den form de står i texten).

## Exempel på svar

{ "titelSv": "Mötet på torget", "text": "María llega al mercado y ve a Juan. …", "textSv": "María kommer fram till torget och ser Juan. …", "kandidatord": ["llega", "cada", …] }`;
}

function ordlistor() {
  // varje ord i sin nivå; verb tar med sina presensformer i parentes
  const niva = { kan: [], nastan: [] };
  for (const id of introducerade) {
    if (kandSet.has(id)) continue;              // kandidaterna har egen lista
    const f = formById.get(id);
    const lemmaId = f ? f.parent : id;
    const w = wordById.get(lemmaId);
    if (!w) continue;
    const box = kanSet.has(lemmaId) ? niva.kan : niva.nastan;
    if (w.pos === "v") {
      const former = lasFormer.get(lemmaId) ?? (formsByParent.get(lemmaId) ?? []).map((x) => x.es);
      const rad = former.length ? `${w.es} (${former.join(", ")})` : w.es;
      if (!box.includes(rad)) box.push(rad);
    } else {
      const rad = w.art ? `${w.art} ${w.es}` : w.es;
      if (!box.includes(rad)) box.push(rad);
    }
  }
  const kand = kandidater.map((id) => `${ytform(id)} (${gloss(id)})`).join("\n");
  return `## Ordlistor

### KAN (verb med sina former i parentes)
${blanda(niva.kan).join(", ")}

### NÄSTAN KAN
${blanda(niva.nastan).join(", ")}

### KANDIDATORD (med svensk betydelse)
${kand}`;
}

function splitMeningar(text) {
  return text.split(/(?<=[.!?…])\s+/u).map((t) => t.trim()).filter(Boolean);
}

/** Koppla deklarerade former till kandidater: känd yta eller verbstam (speglar appen). */
function kopplaDeklarerade(deklarerade) {
  const map = new Map();
  const stam = (es) => es.toLowerCase().replace(/(ar|er|ir)(se)?$/, "");
  for (const ra of deklarerade) {
    const form = String(ra).trim().toLowerCase();
    if (!form) continue;
    const agare =
      kandidater.find((id) => ytorFor(id).some((y) => y.toLowerCase() === form)) ??
      kandidater.find((id) => {
        const es = ytform(id).toLowerCase();
        const st = stam(es);
        return st.length >= 3 && st !== es && form.startsWith(st);
      });
    if (!agare) continue;
    map.set(agare, [...(map.get(agare) ?? []), form]);
  }
  return map;
}

// ---------- körning ----------
const schema = {
  type: "object",
  additionalProperties: false,
  required: ["titelSv", "text", "textSv", "kandidatord"],
  properties: {
    titelSv: { type: "string", description: "Talande titel på SVENSKA (aldrig spanska) — utan kandidatordens betydelser" },
    text: { type: "string", description: "Hela texten på spanska, löpande" },
    textSv: { type: "string", description: "Samma text på naturlig svenska — samma meningar i samma ordning" },
    kandidatord: {
      type: "array",
      items: { type: "string" },
      description: "Kandidatorden du använde, i exakt den form de står i texten",
    },
  },
};

console.log(`Profil: ${introducerade.length} mötta · ${kanIds.length} kan · kandidater: ${kandidater.map((id) => ytform(id)).join(", ")}`);

if (flag("torr") || flag("visa-prompt")) {
  console.log("\n===== PROMPT =====\n" + heleprompten());
  if (flag("torr")) process.exit(0);
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("\nANTHROPIC_API_KEY saknas — kör med --torr för att se prompten.");
  process.exit(1);
}

const client = new Anthropic();
let senaste = null; // { meningar, deklarerade }
let kostnad = 0;

for (let forsok = 1; forsok <= 3; forsok++) {
  const forra = senaste ? validera(senaste.meningar, senaste.deklarerade) : null;
  const feedback = forra
    ? `\n\nDitt förra försök bröt mot reglerna. Otillåtna ord: ${forra.brott.join(", ") || "-"}. Använda kandidatord: ${forra.anvanda.length} av minst ${ORD_LO}. Skriv om och håll dig strikt till listorna.`
    : "";
  const outputConfig = { format: { type: "json_schema", schema } };
  const effort = arg("effort");
  if (effort) outputConfig.effort = effort;
  const res = await client.messages.create({
    model: MODELL,
    max_tokens: 6000,
    output_config: outputConfig,
    messages: [{ role: "user", content: heleprompten() + feedback }],
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
  const svar = JSON.parse(textBlock.text);
  const meningar = splitMeningar(String(svar.text ?? ""));
  const deklarerade = Array.isArray(svar.kandidatord) ? svar.kandidatord : [];
  senaste = { meningar, deklarerade };
  console.log(`\n»${svar.titelSv}«`);
  if (svar.textSv) console.log(`  (sv: ${svar.textSv})`);

  const { brott, anvanda, forFa } = validera(meningar, deklarerade);
  console.log(`\n--- försök ${forsok} ---`);
  for (const m of meningar) console.log(`  ${m}`);
  console.log(`  deklarerade: ${deklarerade.join(", ") || "-"}`);
  console.log(`  valda kandidater: ${anvanda.map(ytform).join(", ") || "-"}`);
  if (!brott.length && !forFa) {
    console.log(`\n✅ GODKÄND av validatorn · ~${(kostnad * 9.5 * 100).toFixed(1)} öre`);
    process.exit(0);
  }
  console.log(`❌ otillåtna: ${brott.join(", ") || "-"}${forFa ? ` · för få kandidatord (${anvanda.length}/${ORD_LO})` : ""}`);
}
console.log("\nUnderkänd efter 3 försök — hellre lucka än fel.");
process.exit(1);
