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
  /** ord som quizzades i förra läsningen — undviks om poolen räcker */
  exkludera?: Set<string>;
  /** injicerbar slump för testerna */
  rng?: () => number;
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
  if (val.exkludera?.size) {
    const utan = pool.filter((id) => !val.exkludera!.has(id));
    if (utan.length >= antalKandidater) pool = utan;
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

  const verbFormer = new Map<string, string[]>();
  const ovriga: string[] = [];
  const vitlista = new Set<string>(SMAORD);
  for (const id of introducerade) {
    const f = store.formById.get(id);
    if (f) {
      vitlista.add(f.es.toLowerCase());
      // moderverbets infinitiv följer med — formen är omöjlig att lista utan den
      const parent = store.byId.get(f.parent);
      if (parent) vitlista.add(parent.es.toLowerCase());
      const list = verbFormer.get(f.parent) ?? [];
      if (!list.includes(f.es)) list.push(f.es);
      verbFormer.set(f.parent, list);
      continue;
    }
    const w = store.byId.get(id);
    if (!w) continue;
    const es = w.es.toLowerCase();
    for (const tok of es.split(/\s+/)) vitlista.add(tok);
    if (w.pos === "v") {
      if (!verbFormer.has(id)) verbFormer.set(id, []);
      continue;
    }
    ovriga.push(w.art ? `${w.art} ${w.es}` : w.es);
    if (BOJBARA.has(w.pos)) bojningar(es, vitlista);
  }
  const verb: LasVerb[] = [...verbFormer.entries()].map(([id, former]) => ({
    inf: store.byId.get(id)?.es ?? id,
    former,
  }));
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

/** Hämta text från Edge Functionen (kräver inloggning — JWT följer med klienten). */
export async function hamtaText(
  sb: SupabaseClient,
  u: LasUnderlag,
  p: LasParametrar,
): Promise<LasMening[]> {
  const { data, error } = await sb.functions.invoke("las-text", {
    body: {
      verb: u.verb,
      ovriga: u.ovriga,
      kandidater: u.kandidater.map(({ es, sv }) => ({ es, sv })),
      vitlista: u.vitlista,
      meningar: p.meningar,
      anvand: p.anvand,
    },
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
  if (data?.fel) throw new Error(data.fel);
  if (!Array.isArray(data?.meningar)) throw new Error("Konstigt svar från textmotorn.");
  return data.meningar as LasMening[];
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
