// Glosa · läsförståelse — genererar en minitext av användarens egna ord.
//
// Anropas av appen (inloggad användare krävs). Klienten skickar palett,
// kandidatord och vitlista; funktionen promptar claude-sonnet-5, validerar
// mot vitlistan och försöker om (max 3). Nyckeln ligger i Supabase secrets
// (ANTHROPIC_API_KEY) och lämnar aldrig servern.
//
// POST-body:
// {
//   verb:       [{ inf: "poder", former: ["puedo", "puede"] }, ...],
//   ovriga:     ["el perro", "aquí", ...],          // visningsformer
//   kandidater: [{ es: "cada", sv: "varje" }, ...], // FSRS-valda, 2N st
//   vitlista:   ["cada", "perro", "perros", ...],   // tillåtna tokens (expanderad)
//   meningar:   4,                                  // ungefärligt antal
//   anvand:     3                                   // minst så många kandidater
// }
// Svar 200: { meningar: [{ es, ovningsord }], anvanda: ["cada", ...], forsok: 2 }
// Svar 422: { fel: "..." }  — godkändes inte efter 3 försök (hellre lucka än fel)
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

// alltid tillåten bindväv — quizzas aldrig
const SMAORD = ["el", "la", "los", "las", "un", "una", "unos", "unas", "a", "al", "del", "no"];
const MODELL = "claude-sonnet-5";

interface Verb { inf: string; former: string[] }
interface Kandidat { es: string; sv: string }
interface Beställning {
  verb: Verb[];
  ovriga: string[];
  kandidater: Kandidat[];
  vitlista: string[];
  meningar: number;
  anvand: number;
}
interface Mening { es: string; ovningsord: string }

const ren = (s: unknown, max = 60) =>
  String(s ?? "").replace(/[\n\r]/g, " ").trim().slice(0, max);

/** Klampa och tvätta inkommande data — vi litar inte på klienten. */
function tolka(body: Record<string, unknown>): Beställning {
  const verb = (Array.isArray(body.verb) ? body.verb : []).slice(0, 800)
    .map((v: Record<string, unknown>) => ({
      inf: ren(v?.inf),
      former: (Array.isArray(v?.former) ? v.former : []).slice(0, 12).map((f) => ren(f)),
    }))
    .filter((v) => v.inf);
  const ovriga = (Array.isArray(body.ovriga) ? body.ovriga : []).slice(0, 2000)
    .map((o) => ren(o)).filter(Boolean);
  const kandidater = (Array.isArray(body.kandidater) ? body.kandidater : []).slice(0, 24)
    .map((k: Record<string, unknown>) => ({ es: ren(k?.es), sv: ren(k?.sv) }))
    .filter((k) => k.es);
  const vitlista = (Array.isArray(body.vitlista) ? body.vitlista : []).slice(0, 6000)
    .map((t) => ren(t).toLowerCase()).filter(Boolean);
  const meningar = Math.min(Math.max(Number(body.meningar) || 3, 1), 10);
  const anvand = Math.min(Math.max(Number(body.anvand) || 2, 1), kandidater.length || 1);
  return { verb, ovriga, kandidater, vitlista, meningar, anvand };
}

function systemPrompt(b: Beställning): string {
  return `Du skriver en pytteliten sammanhängande scen på enkel spanska (presens) för svenska nybörjare — ungefär ${b.meningar} meningar som hör ihop.

REGLER:
- Använd ENDAST ord från listorna nedan. Inga andra ord, inga namn, inga siffertecken.
- Verb får bara användas i exakt de former som står i verblistan. Saknas formen: skriv om (ir a/querer/poder + infinitiv) eller välj ett annat verb.
- Substantiv, adjektiv, pronomen och determinerare får böjas i regelbunden plural och femininum.
- Alltid tillåtna småord: el, la, los, las, un, una, a, al, del, no.
- Använd exakt ${b.anvand} av KANDIDATORDEN, i exakt angiven form — välj de som passar scenen bäst.
- Vanligaste felet är verbformer utanför listan (t.ex. "quiere" när bara "quiero" står med) — kontrollera varje verbform innan du svarar.

Svara i JSON: en lista "meningar" där varje element har "es" (meningen) och "ovningsord" (kandidatordet i meningen, eller "" om inget).`;
}

function userPrompt(b: Beställning): string {
  const verb = b.verb
    .map((v) => (v.former.length ? `${v.inf}: ${v.inf}, ${v.former.join(", ")}` : v.inf))
    .join(" · ");
  const kand = b.kandidater.map((k) => `${k.es} (${k.sv})`).join("\n");
  return `VERB — endast dessa former är tillåtna:\n${verb}\n\nÖVRIGA TILLÅTNA ORD:\n${b.ovriga.join(", ")}\n\nKANDIDATORD (välj ${b.anvand} st, exakt dessa former):\n${kand}`;
}

function tokenisera(text: string): string[] {
  return text.toLowerCase().match(/[a-záéíóúñü]+/g) ?? [];
}

function validera(b: Beställning, meningar: Mening[]) {
  const ok = new Set([...SMAORD, ...b.vitlista]);
  const brott = new Set<string>();
  for (const m of meningar) {
    for (const tok of tokenisera(m.es)) if (!ok.has(tok)) brott.add(tok);
  }
  const text = " " + meningar.map((m) => m.es).join(" ").toLowerCase() + " ";
  const anvanda = b.kandidater
    .map((k) => k.es)
    .filter((es) =>
      new RegExp(`(^|[^a-záéíóúñü])${es.toLowerCase()}([^a-záéíóúñü]|$)`).test(text)
    );
  return { brott: [...brott], anvanda, godkand: brott.size === 0 && anvanda.length >= b.anvand };
}

const SCHEMA = {
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { fel: "bara POST" });

  // kräver inloggad användare — anon-nyckeln räcker inte
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
  );
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json(401, { fel: "logga in först" });

  let b: Beställning;
  try {
    b = tolka(await req.json());
  } catch {
    return json(400, { fel: "ogiltig JSON" });
  }
  if (!b.kandidater.length || !b.vitlista.length) {
    return json(400, { fel: "kandidater och vitlista krävs" });
  }

  const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY")! });
  let meningar: Mening[] | null = null;

  for (let forsok = 1; forsok <= 3; forsok++) {
    const forra = meningar ? validera(b, meningar) : null;
    const extra = forra
      ? `\n\nDitt förra försök bröt mot reglerna. Otillåtna ord: ${forra.brott.join(", ") || "-"}. Använda kandidatord: ${forra.anvanda.length} av minst ${b.anvand}. Skriv om och håll dig strikt till listorna.`
      : "";
    let res;
    try {
      res = await anthropic.messages.create({
        model: MODELL,
        max_tokens: 6000,
        system: systemPrompt(b),
        output_config: { format: { type: "json_schema", schema: SCHEMA }, effort: "medium" },
        messages: [{ role: "user", content: userPrompt(b) + extra }],
      });
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 429 || status === 529) return json(503, { fel: "modellen är upptagen — prova strax igen" });
      console.error("anthropic:", e);
      return json(502, { fel: "textmotorn svarade inte" });
    }
    if (res.stop_reason === "refusal") return json(502, { fel: "textmotorn avböjde" });
    const textBlock = res.content.find((c) => c.type === "text");
    if (!textBlock || textBlock.type !== "text") continue;
    try {
      meningar = (JSON.parse(textBlock.text) as { meningar: Mening[] }).meningar;
    } catch {
      continue;
    }
    const v = validera(b, meningar);
    if (v.godkand) {
      return json(200, { meningar, anvanda: v.anvanda, forsok });
    }
  }
  return json(422, { fel: "kunde inte skriva en text som håller sig till dina ord — försök igen" });
});
