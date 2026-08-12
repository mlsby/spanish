import type { Store } from "./store";
import type { SupabaseClient } from "./supabase";
import { applyReview, KNOWN_STABILITY_DAYS } from "./scheduler";
import type { Grade, Step } from "./types";

/**
 * Läsförståelse: bygger underlaget (palett, kandidater, vitlista) ur
 * användarens egna kort, anropar Edge Functionen som genererar texten,
 * och bokför ordfrågorna som riktiga FSRS-repetitioner (es→sv).
 * Ren logik utan DOM — vyn bor i views/las.ts.
 */

export const LAS_UNLOCK = 100; // Turista — där låses läsningen upp

export interface LasParametrar { meningar: number; anvand: number }

/** Textlängd per resa-nivå (docs/research-lasforstaelse.md). */
export function lasNiva(score: number): LasParametrar {
  if (score >= 2000) return { meningar: 8, anvand: 6 };
  if (score >= 1000) return { meningar: 6, anvand: 5 };
  if (score >= 500) return { meningar: 5, anvand: 4 };
  if (score >= 200) return { meningar: 4, anvand: 3 };
  return { meningar: 3, anvand: 2 };
}

export interface LasKandidat { id: string; es: string; sv: string }
export interface LasVerb { inf: string; former: string[] }
export interface LasUnderlag {
  verb: LasVerb[];
  ovriga: string[];
  kandidater: LasKandidat[];
  vitlista: string[];
}
export interface LasMening { es: string; ovningsord: string }
export interface LasFraga { kandidat: LasKandidat; mening: string }

// alltid tillåten bindväv — quizzas aldrig (samma lista som i Edge Functionen)
const SMAORD = ["el", "la", "los", "las", "un", "una", "unos", "unas", "a", "al", "del", "no"];
// ser/estar/hay i presens är också bindväv — utan dem blir varje text tarzanspanska
const VERBGLUE = ["es", "son", "está", "están", "hay"];
const BOJBARA = new Set(["n", "adj", "determiner", "pron", "num"]);

/** Regelbunden plural + femininum in i vitlistan (perro→perros, feliz→felices). */
function bojningar(es: string, ok: Set<string>): void {
  if (es.endsWith("z")) ok.add(es.slice(0, -1) + "ces");
  else ok.add(es + (/[aeiouáéíóú]$/.test(es) ? "s" : "es"));
  if (es.endsWith("o")) {
    ok.add(es.slice(0, -1) + "a");
    ok.add(es.slice(0, -1) + "as");
    ok.add(es.slice(0, -1) + "os");
  }
}

export interface UnderlagVal {
  /**
   * Nyligen quizzade ord — utesluts HELT (kandidater, palett och vitlista)
   * om kandidatpoolen räcker ändå. Annars skulle LLM:en kunna återanvända
   * dem som palettord ändå ("Cada día …" i varenda text).
   */
  exkludera?: Set<string>;
  /** injicerbar slump för testerna */
  rng?: () => number;
}

/**
 * Rullande minne av quizzade ord: nyaste först, dubbletter bort, max `tak`.
 * Vyn persisterar listan så variationen överlever omladdningar.
 */
export function minnsQuizzade(gamla: string[], nya: string[], tak: number): string[] {
  return [...nya, ...gamla.filter((id) => !nya.includes(id))].slice(0, tak);
}

/**
 * Palett + kandidater ur kortdatan. Kandidatpoolen är FSRS-viktad (lägst
 * stabilitet först) men själva urvalet slumpas ur ett fönster av de 2×
 * skörast — annars blir det exakt samma ord varje läsning, eftersom ett
 * rätt svar bara höjer stabiliteten marginellt.
 */
export function byggUnderlag(
  store: Store,
  antalKandidater: number,
  val: UnderlagVal = {},
): LasUnderlag {
  const minS = new Map<string, number>();
  const dirs = new Map<string, number>();
  for (const rec of Object.values(store.data.cards)) {
    if (rec.fsrs.reps <= 0) continue;
    dirs.set(rec.wordId, (dirs.get(rec.wordId) ?? 0) + 1);
    minS.set(rec.wordId, Math.min(minS.get(rec.wordId) ?? Infinity, rec.fsrs.stability));
  }
  const introducerade = [...dirs.keys()];
  const kan = (id: string) =>
    (dirs.get(id) ?? 0) >= 2 && (minS.get(id) ?? 0) >= KNOWN_STABILITY_DAYS;

  let pool = introducerade
    .filter((id) => !kan(id))
    .filter((id) => {
      const c = store.card(id, "es2sv");
      return !!c && c.fsrs.reps > 0;
    })
    .sort((a, b) => (minS.get(a) ?? 0) - (minS.get(b) ?? 0));
  let uteslut = new Set<string>(); // aktiv exkludering — gäller även paletten nedan
  if (val.exkludera?.size) {
    const utan = pool.filter((id) => !val.exkludera!.has(id));
    if (utan.length >= antalKandidater) { pool = utan; uteslut = val.exkludera; }
  }
  // slumpa urvalet ur fönstret av de skörast — Fisher-Yates
  const fonster = pool.slice(0, antalKandidater * 2);
  const rng = val.rng ?? Math.random;
  for (let i = fonster.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [fonster[i], fonster[j]] = [fonster[j], fonster[i]];
  }
  const kandidater: LasKandidat[] = [];
  for (const id of fonster) {
    if (kandidater.length >= antalKandidater) break;
    const f = store.formById.get(id);
    if (f) kandidater.push({ id, es: f.es, sv: f.svPres });
    else {
      const w = store.byId.get(id);
      if (w) kandidater.push({ id, es: w.es, sv: w.sv });
    }
  }

  const verbIds = new Set<string>();
  const ovriga: string[] = [];
  const vitlista = new Set<string>([...SMAORD, ...VERBGLUE]);
  for (const id of introducerade) {
    if (uteslut.has(id)) continue; // borta ur palett + vitlista → kan inte dyka upp i texten
    const f = store.formById.get(id);
    if (f) {
      vitlista.add(f.es.toLowerCase());
      // moderverbets infinitiv följer med — formen är omöjlig att lista utan den
      const parent = store.byId.get(f.parent);
      if (parent) vitlista.add(parent.es.toLowerCase());
      verbIds.add(f.parent);
      continue;
    }
    const w = store.byId.get(id);
    if (!w) continue;
    const es = w.es.toLowerCase();
    for (const tok of es.split(/\s+/)) vitlista.add(tok);
    if (w.pos === "v") {
      verbIds.add(id);
      continue;
    }
    ovriga.push(w.art ? `${w.art} ${w.es}` : w.es);
    if (BOJBARA.has(w.pos)) bojningar(es, vitlista);
  }
  // mött verb ⇒ ALLA dess presensformer får läsas i texten (quizzas aldrig) —
  // med bara de mötta formerna tvingades modellen till "yo querer hablar"
  const verb: LasVerb[] = [...verbIds].map((id) => {
    const former: string[] = [];
    for (const f of store.formsByParent.get(id) ?? []) {
      if (uteslut.has(f.id) || former.includes(f.es)) continue;
      former.push(f.es);
      vitlista.add(f.es.toLowerCase());
    }
    return { inf: store.byId.get(id)?.es ?? id, former };
  });
  return { verb, ovriga, kandidater, vitlista: [...vitlista] };
}

/** Finns ordet (hel yta, inte delsträng) i texten? */
export function ordITexten(es: string, text: string): boolean {
  const safe = es.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-záéíóúñü])${safe}([^a-záéíóúñü]|$)`).test(` ${text.toLowerCase()} `);
}

/**
 * En fråga per ANVÄNT kandidatord, i textens ordning. Kandidater får numera
 * klumpa ihop sig i samma mening — därför letar vi per kandidat, inte per
 * mening, så inget ord tappas när två delar mening.
 */
export function byggQuiz(meningar: LasMening[], kandidater: LasKandidat[]): LasFraga[] {
  const traffar: { fraga: LasFraga; ordning: number }[] = [];
  for (const k of kandidater) {
    const i = meningar.findIndex((m) => ordITexten(k.es, m.es));
    if (i >= 0) traffar.push({ fraga: { kandidat: k, mening: meningar[i].es }, ordning: i });
  }
  return traffar.sort((a, b) => a.ordning - b.ordning).map((t) => t.fraga);
}

// ---------- prompt + validering (bor i appen — Edge Functionen är bara nyckelhållare) ----------

const LAS_SCHEMA = {
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

export function lasSystemPrompt(p: LasParametrar): string {
  return `Du skriver en pytteliten sammanhängande scen på enkel spanska (presens) för svenska nybörjare — ungefär ${p.meningar} meningar som hör ihop.

REGLER:
- Använd ENDAST ord från listorna nedan. Inga andra ord, inga namn, inga siffertecken.
- Verb får bara användas i exakt de former som står i verblistan. Saknas formen: skriv om (ir a/querer/poder + infinitiv) eller välj ett annat verb.
- Substantiv, adjektiv, pronomen och determinerare får böjas i regelbunden plural och femininum.
- Alltid tillåtna småord: ${SMAORD.filter((s) => !["unos", "unas"].includes(s)).join(", ")} — och verben ${VERBGLUE.join(", ")}.
- Använd exakt ${p.anvand} av KANDIDATORDEN, i exakt angiven form — välj de som passar scenen bäst.
- Vanligaste felet är verbformer utanför listan (t.ex. "quiere" när bara "quiero" står med) — kontrollera varje verbform innan du svarar.

Svara i JSON: en lista "meningar" där varje element har "es" (meningen) och "ovningsord" (kandidatordet i meningen, eller "" om inget).`;
}

export function lasUserPrompt(u: LasUnderlag, anvand: number): string {
  const verb = u.verb
    .map((v) => (v.former.length ? `${v.inf}: ${v.inf}, ${v.former.join(", ")}` : v.inf))
    .join(" · ");
  const kand = u.kandidater.map((k) => `${k.es} (${k.sv})`).join("\n");
  return `VERB — endast dessa former är tillåtna:\n${verb}\n\nÖVRIGA TILLÅTNA ORD:\n${u.ovriga.join(", ")}\n\nKANDIDATORD (välj ${anvand} st, exakt dessa former):\n${kand}`;
}

function tokenisera(text: string): string[] {
  return text.toLowerCase().match(/[a-záéíóúñü]+/g) ?? [];
}

export interface LasValidering { brott: string[]; anvanda: string[]; godkand: boolean }

/** Håller sig texten till vitlistan och använder den nog många kandidater? */
export function valideraText(
  u: LasUnderlag,
  anvand: number,
  meningar: LasMening[],
): LasValidering {
  const ok = new Set(u.vitlista.map((t) => t.toLowerCase()));
  const brott = new Set<string>();
  for (const m of meningar) {
    for (const tok of tokenisera(m.es)) if (!ok.has(tok)) brott.add(tok);
  }
  const text = meningar.map((m) => m.es).join(" ");
  const anvanda = u.kandidater.filter((k) => ordITexten(k.es, text)).map((k) => k.es);
  return { brott: [...brott], anvanda, godkand: brott.size === 0 && anvanda.length >= anvand };
}

/**
 * Hämta text via den generiska promptmotorn (kräver inloggning — JWT följer
 * med klienten). Appen validerar och försöker om (max 3) med felen som
 * feedback — hellre lucka än fel text.
 */
export async function hamtaText(
  sb: SupabaseClient,
  u: LasUnderlag,
  p: LasParametrar,
): Promise<LasMening[]> {
  const system = lasSystemPrompt(p);
  const bas = lasUserPrompt(u, p.anvand);
  let meningar: LasMening[] | null = null;
  for (let forsok = 1; forsok <= 3; forsok++) {
    const forra: LasValidering | null = meningar ? valideraText(u, p.anvand, meningar) : null;
    const extra: string = forra
      ? `\n\nDitt förra försök bröt mot reglerna. Otillåtna ord: ${forra.brott.join(", ") || "-"}. Använda kandidatord: ${forra.anvanda.length} av minst ${p.anvand}. Skriv om och håll dig strikt till listorna.`
      : "";
    const { data, error } = await sb.functions.invoke<{ text?: string; fel?: string }>("prompt", {
      body: { system, user: bas + extra, schema: LAS_SCHEMA, effort: "medium" },
    });
    if (error) {
      let msg = "Kunde inte hämta texten — prova igen om en stund.";
      try {
        const ctx = (error as { context?: Response }).context;
        const j = ctx ? await ctx.json() : null;
        if (j?.fel) msg = j.fel;
      } catch { /* behåll standardmeddelandet */ }
      throw new Error(msg);
    }
    if (data?.fel) throw new Error(String(data.fel));
    let svar: LasMening[] | undefined;
    try {
      svar = (JSON.parse(String(data?.text ?? "")) as { meningar: LasMening[] }).meningar;
    } catch { continue; /* trasig JSON räknas som misslyckat försök */ }
    if (!Array.isArray(svar)) continue;
    meningar = svar;
    if (valideraText(u, p.anvand, meningar).godkand) return meningar;
  }
  throw new Error("Kunde inte skriva en text som håller sig till dina ord — försök igen.");
}

/**
 * Bokför ett ordsvar som riktig FSRS-repetition på es→sv-kortet.
 * Samma regler som passet: svenskt stavfel (hard) rättas som good.
 */
export function lasCommit(
  store: Store,
  wordId: string,
  grade: Grade,
  raw: string,
  step: Step,
  now: Date = new Date(),
): void {
  const rec = store.card(wordId, "es2sv");
  if (!rec) return;
  const fsrsGrade: Grade = grade === "hard" ? "good" : grade;
  const updated = applyReview(rec, fsrsGrade, now); // räknar även upp failCount vid fel
  store.putCard(updated);
  store.logReview({
    ts: now.toISOString(),
    wordId,
    dir: "es2sv",
    raw,
    grade: fsrsGrade,
    step,
  });
  store.save();
}
