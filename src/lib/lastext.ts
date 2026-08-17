import type { Store } from "./store";
import type { SupabaseClient } from "./supabase";
import { applyReview, KNOWN_STABILITY_DAYS } from "./scheduler";
import { PERSON_SV_SVAR } from "./types";
import type { Grade, Step } from "./types";

/**
 * Läsförståelse: bygger underlaget (palett, kandidater, vitlista) ur
 * användarens egna kort, anropar Edge Functionen som genererar texten,
 * och bokför ordfrågorna som riktiga FSRS-repetitioner (es→sv).
 * Ren logik utan DOM — vyn bor i views/las.ts.
 */

export const LAS_UNLOCK = 100; // Turista — där låses läsningen upp

export interface LasParametrar { meningar: number; anvand: number }

/** Textlängd per resa-nivå (docs/research-lasforstaelse.md). Max 6 meningar — längre blev prov, inte läsning. */
export function lasNiva(score: number): LasParametrar {
  if (score >= 2000) return { meningar: 6, anvand: 6 };
  if (score >= 1000) return { meningar: 6, anvand: 5 };
  if (score >= 500) return { meningar: 5, anvand: 4 };
  if (score >= 200) return { meningar: 4, anvand: 3 };
  return { meningar: 3, anvand: 2 };
}

/** Kandidatkravets golv: ett spann (t.ex. 4–6) ger berättarfrihet — exakt antal gav prov-texter. */
export function ordLo(p: LasParametrar): number {
  return Math.min(p.anvand, Math.max(2, p.anvand - 2));
}

export interface LasKandidat { id: string; es: string; sv: string }
export interface LasUnderlag {
  /** ord som sitter — verb med sina former i parentes ("hablar (hablo, hablas …)") */
  kan: string[];
  /** mötta men vingliga ord — reserv när scenen behöver dem */
  nastan: string[];
  kandidater: LasKandidat[];
  vitlista: string[];
}
export interface LasMening { es: string }

/**
 * Modellen levererar löpande text — appen delar i meningar själv (quizet
 * visar meningen där ordet står). Enkel spanska: punkt/!/?/… avslutar.
 */
export function splitMeningar(text: string): LasMening[] {
  return text
    .split(/(?<=[.!?…])\s+/u)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((es) => ({ es }));
}
export interface LasFraga {
  kandidat: LasKandidat;
  mening: string;
  /** ytan som faktiskt står i meningen — kan vara en böjd form av kandidaten */
  yta: string;
}

// alltid tillåten bindväv — quizzas aldrig (samma lista som i Edge Functionen)
const SMAORD = ["el", "la", "los", "las", "un", "una", "unos", "unas", "a", "al", "del", "no"];
// ser/estar/hay i presens är också bindväv — utan dem blir varje text tarzanspanska
const VERBGLUE = ["es", "son", "está", "están", "hay"];
// vanliga förnamn — fria historier vill namnge sina karaktärer; quizzas aldrig
const NAMN = [
  "juan", "maría", "ana", "pedro", "luis", "carmen", "sofía", "carlos", "lucía",
  "miguel", "elena", "pablo", "marta", "diego", "rosa", "david", "laura", "josé",
  "clara", "antonio",
];
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

  // kandidater väljs bara bland grundord (icke-verb + verbens infinitiv) —
  // böjningsformerna quizzas i passet och ska inte äta kandidatplatserna
  let pool = introducerade
    .filter((id) => !store.formById.has(id))
    .filter((id) => !kan(id))
    .filter((id) => {
      const c = store.card(id, "es2sv");
      return !!c && c.fsrs.reps > 0;
    })
    .sort((a, b) => (minS.get(a) ?? 0) - (minS.get(b) ?? 0));
  let uteslut = new Set<string>(); // aktiv exkludering — gäller även listorna nedan
  if (val.exkludera?.size) {
    const utan = pool.filter((id) => !val.exkludera!.has(id));
    if (utan.length >= antalKandidater) { pool = utan; uteslut = val.exkludera; }
  }
  const rng = val.rng ?? Math.random;
  const blanda = <T>(a: T[]): T[] => {
    const x = [...a];
    for (let i = x.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [x[i], x[j]] = [x[j], x[i]];
    }
    return x;
  };
  // slumpa urvalet ur fönstret av de skörast — annars samma ord varje läsning
  const kandidater: LasKandidat[] = [];
  for (const id of blanda(pool.slice(0, antalKandidater * 2))) {
    if (kandidater.length >= antalKandidater) break;
    const w = store.byId.get(id);
    if (w) kandidater.push({ id, es: w.es, sv: w.sv });
  }
  const kandSet = new Set(kandidater.map((k) => k.id));

  // ---- listorna: varje ord i sin nivå, kandidaterna har egen lista ----
  const kanRader: string[] = [];
  const nastanRader: string[] = [];
  const vitlista = new Set<string>([...SMAORD, ...VERBGLUE, ...NAMN]);
  const verbKlara = new Set<string>();
  for (const id of introducerade) {
    if (uteslut.has(id)) continue; // borta ur listor + vitlista → kan inte dyka upp
    const form = store.formById.get(id);
    const lemmaId = form ? form.parent : id;
    if (uteslut.has(lemmaId) || kandSet.has(lemmaId)) continue;
    const w = store.byId.get(lemmaId);
    if (!w) continue;
    const rader = kan(lemmaId) ? kanRader : nastanRader;
    if (w.pos === "v") {
      if (verbKlara.has(lemmaId)) continue;
      verbKlara.add(lemmaId);
      // mött verb ⇒ hela presensparadigmet får läsas (quizzas aldrig) — annars
      // tvingas modellen till infinitivsoppa: "yo querer hablar"
      const former = store.lasFormer.get(lemmaId)
        ?? (store.formsByParent.get(lemmaId) ?? []).map((f) => f.es);
      vitlista.add(w.es.toLowerCase());
      for (const f of former) vitlista.add(f.toLowerCase());
      rader.push(former.length ? `${w.es} (${former.join(", ")})` : w.es);
      continue;
    }
    const es = w.es.toLowerCase();
    for (const tok of es.split(/\s+/)) vitlista.add(tok);
    if (BOJBARA.has(w.pos)) bojningar(es, vitlista);
    rader.push(w.art ? `${w.art} ${w.es}` : w.es);
  }
  // kandidaterna själva måste förstås också vara tillåtna i texten
  for (const k of kandidater) {
    const es = k.es.toLowerCase();
    for (const tok of es.split(/\s+/)) vitlista.add(tok);
    const w = store.byId.get(k.id);
    if (w && BOJBARA.has(w.pos)) bojningar(es, vitlista);
  }
  return {
    kan: blanda(kanRader),
    nastan: blanda(nastanRader),
    kandidater,
    vitlista: [...vitlista],
  };
}

/**
 * Kandidatens godtagbara ytor: grundformen + (för verb) dess presensformer.
 * Ett verb i en scen böjs — "llegar" dyker upp som "llega". Kortet som förhörs
 * är ändå grundformen; meningen visar den form som faktiskt användes.
 */
export function kandidatYtor(store: Store, k: LasKandidat): string[] {
  const w = store.byId.get(k.id);
  if (w?.pos !== "v") return [k.es];
  return [k.es, ...(store.lasFormer.get(k.id) ?? [])];
}

/** Svenska böjningsvarianter av en glosa — generösa: hellre godkänna "visade" än kräva "visa". */
function svBojda(t: string): string[] {
  const ut = [t];
  if (t.endsWith("a")) {
    const stam = t.slice(0, -1);
    ut.push(t + "r", stam + "er", t + "de", t + "t", stam + "dde", stam + "tt");
  } else {
    ut.push(t + "r", t + "dde", t + "tt");
  }
  return ut;
}

/**
 * Extra facit när quizets yta är en BÖJD form av kandidaten ("muestra" för
 * mostrar): känd presensform ger sina pronomenvarianter ("han visar"), och
 * grundfacitets glosor godtas i svensk böjd form — att översätta formen man
 * faktiskt läste ska aldrig räknas som fel.
 */
export function bojdaTargets(store: Store, kandidat: LasKandidat, yta: string): string[] {
  if (yta.toLowerCase() === kandidat.es.toLowerCase()) return [];
  const extra: string[] = [];
  const form = (store.formsByParent.get(kandidat.id) ?? [])
    .find((x) => x.es.toLowerCase() === yta.toLowerCase());
  if (form) {
    extra.push(...PERSON_SV_SVAR[form.person].map((pr) => `${pr} ${form.svPres}`), form.svPres);
  }
  const w = store.byId.get(kandidat.id);
  for (const glosa of [w?.sv ?? kandidat.sv, ...(w?.syn ?? [])]) {
    extra.push(...svBojda(glosa));
  }
  return extra;
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
export function byggQuiz(
  meningar: LasMening[],
  kandidater: LasKandidat[],
  ytor: (k: LasKandidat) => string[] = (k) => [k.es],
): LasFraga[] {
  const traffar: { fraga: LasFraga; ordning: number }[] = [];
  for (const k of kandidater) {
    let bast = -1, bastYta = k.es;
    for (const yta of ytor(k)) {
      const i = meningar.findIndex((m) => ordITexten(yta, m.es));
      if (i >= 0 && (bast < 0 || i < bast)) { bast = i; bastYta = yta; }
    }
    if (bast >= 0) {
      traffar.push({ fraga: { kandidat: k, mening: meningar[bast].es, yta: bastYta }, ordning: bast });
    }
  }
  return traffar.sort((a, b) => a.ordning - b.ordning).map((t) => t.fraga);
}

// ---------- prompt + validering (bor i appen — Edge Functionen är bara nyckelhållare) ----------

const LAS_SCHEMA = {
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

/** Hela läsprompten som EN text — instruktion, ordlistor, format och exempel sist. */
export function lasPrompt(u: LasUnderlag, p: LasParametrar): string {
  const menLo = Math.max(2, p.meningar - 1);
  const spann = ordLo(p) === p.anvand ? `${p.anvand}` : `${ordLo(p)}–${p.anvand}`;
  const kand = u.kandidater.map((k) => `${k.es} (${k.sv})`).join("\n");
  return `Skriv en kort text på enkel spanska för en svensk som lär sig språket: ${menLo}–${p.meningar} meningar som hänger ihop — en liten historia, en konversation eller en blandning, det som blir mest levande.

Använd orden i KAN-listan och väv in ${spann} av KANDIDATORDEN — inte fler, läsaren förhörs på dem efter läsningen. NÄSTAN KAN-orden finns om flytet kräver dem. Alltid ok är ${SMAORD.filter((x) => !["unos", "unas"].includes(x)).join(", ")}, ${VERBGLUE.join(", ")}, regelbunden plural och femininum samt vanliga spanska förnamn. Alla andra ord är förbjudna — ett okänt ord och läsaren tappar tråden.

Verb använder du helst i formerna som står i parentes. Behöver berättelsen en annan böjning av ett kandidatord går det bra — men håll det på en nivå du tror att läsaren förstår.

Titeln skrivs på svenska: talande, sätter scenen, står fri från ordlistorna. Avslöja bara inte kandidatordens betydelser — läsaren förhörs på dem efteråt.

## Ordlistor

### KAN (verb med sina former i parentes)
${u.kan.join(", ")}

### NÄSTAN KAN
${u.nastan.join(", ")}

### KANDIDATORD (med svensk betydelse)
${kand}

## Svarsformat

JSON med fyra fält: "titelSv" (titeln), "text" (hela texten på spanska), "textSv" (samma text på naturlig svenska — samma meningar i samma ordning), "kandidatord" (de kandidatord du använde, i exakt den form de står i texten).

## Exempel på svar

{ "titelSv": "Mötet på torget", "text": "María llega al mercado y ve a Juan. …", "textSv": "María kommer fram till torget och ser Juan. …", "kandidatord": ["llega", "cada", …] }`;
}

/**
 * Koppla modellens deklarerade former till sina kandidater: känd yta först,
 * annars verbstam (llegó → llegar). Okopplade deklarationer skyddar inget.
 */
export function kopplaKandidatord(
  kandidater: LasKandidat[],
  deklarerade: string[],
  ytor: (k: LasKandidat) => string[],
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const stam = (es: string) => es.toLowerCase().replace(/(ar|er|ir)(se)?$/, "");
  for (const ra of deklarerade) {
    const form = ra.trim().toLowerCase();
    if (!form) continue;
    const agare =
      kandidater.find((k) => ytor(k).some((y) => y.toLowerCase() === form)) ??
      kandidater.find((k) => {
        const s = stam(k.es);
        return s.length >= 3 && s !== k.es.toLowerCase() && form.startsWith(s);
      });
    if (!agare) continue;
    const list = map.get(agare.id) ?? [];
    if (!list.includes(form)) list.push(form);
    map.set(agare.id, list);
  }
  return map;
}

function tokenisera(text: string): string[] {
  return text.toLowerCase().match(/[a-záéíóúñü]+/g) ?? [];
}

export interface LasValidering { brott: string[]; anvanda: string[]; godkand: boolean }

/**
 * Håller sig texten till vitlistan och använder den nog många kandidater?
 * `minAnvand` är kandidatgolvet (spannets nedre kant). `extra` är deklarerade
 * kandidatböjningar kopplade till sina ägare (kandidat-id → former) — de
 * fäller inte texten och räknas som användning.
 */
export function valideraText(
  u: LasUnderlag,
  minAnvand: number,
  meningar: LasMening[],
  ytor: (k: LasKandidat) => string[] = (k) => [k.es],
  extra: Map<string, string[]> = new Map(),
): LasValidering {
  const ok = new Set(u.vitlista.map((t) => t.toLowerCase()));
  const tillat = new Set([...extra.values()].flat().map((t) => t.toLowerCase()));
  const brott = new Set<string>();
  for (const m of meningar) {
    for (const tok of tokenisera(m.es)) if (!ok.has(tok) && !tillat.has(tok)) brott.add(tok);
  }
  const text = meningar.map((m) => m.es).join(" ");
  // kandidatverb godtas i valfri egen form — "llegar" räknas som använt av "llega"
  const anvanda = u.kandidater
    .filter((k) => [...ytor(k), ...(extra.get(k.id) ?? [])].some((y) => ordITexten(y, text)))
    .map((k) => k.es);
  return { brott: [...brott], anvanda, godkand: brott.size === 0 && anvanda.length >= minAnvand };
}

/**
 * Hämta text via den generiska promptmotorn (kräver inloggning — JWT följer
 * med klienten). Appen validerar och försöker om (max 3) med felen som
 * feedback — hellre lucka än fel text.
 */
export interface LasText { titel: string; meningar: LasMening[]; oversattning: string[]; kandidatord: string[] }

export async function hamtaText(
  sb: SupabaseClient,
  u: LasUnderlag,
  p: LasParametrar,
  ytor: (k: LasKandidat) => string[] = (k) => [k.es],
): Promise<LasText> {
  const bas = lasPrompt(u, p);
  let senaste: { meningar: LasMening[]; deklarerade: string[] } | null = null;
  for (let forsok = 1; forsok <= 3; forsok++) {
    let feedback = "";
    if (senaste) {
      const koppling = kopplaKandidatord(u.kandidater, senaste.deklarerade, ytor);
      const forra = valideraText(u, ordLo(p), senaste.meningar, ytor, koppling);
      feedback = `\n\nDitt förra försök bröt mot reglerna. Otillåtna ord: ${forra.brott.join(", ") || "-"}. Använda kandidatord: ${forra.anvanda.length} av minst ${ordLo(p)}. Skriv om och håll dig strikt till listorna.`;
    }
    const { data, error } = await sb.functions.invoke<{ text?: string; fel?: string }>("prompt", {
      body: { user: bas + feedback, schema: LAS_SCHEMA, effort: "medium" },
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
    let svar: { titelSv?: unknown; text?: unknown; textSv?: unknown; kandidatord?: unknown };
    try {
      svar = JSON.parse(String(data?.text ?? "")) as typeof svar;
    } catch { continue; /* trasig JSON räknas som misslyckat försök */ }
    if (typeof svar.text !== "string" || !svar.text.trim()) continue;
    const meningar = splitMeningar(svar.text);
    const deklarerade = Array.isArray(svar.kandidatord) ? svar.kandidatord.map(String) : [];
    senaste = { meningar, deklarerade };
    const koppling = kopplaKandidatord(u.kandidater, deklarerade, ytor);
    if (valideraText(u, ordLo(p), meningar, ytor, koppling).godkand) {
      return {
        titel: typeof svar.titelSv === "string" ? svar.titelSv : "",
        meningar,
        oversattning: typeof svar.textSv === "string"
          ? splitMeningar(svar.textSv).map((m) => m.es)
          : [],
        kandidatord: deklarerade,
      };
    }
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
