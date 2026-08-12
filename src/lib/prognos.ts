import type { CardRec } from "./types";

/**
 * Mexiko-prognosen: hela gänget åker 26 dec 2026 — grafen visar orden man
 * har nu (kan + på gång) och var man landar om takten håller i sig.
 *
 * Takten räknas ur KORTEN (de synkas mellan enheter — review-loggen gör det
 * inte): ett ord räknas den dag det introducerades, förutsatt att det fått
 * minst ett svar (obesvarade introduktioner ger ingen poäng och räknas inte).
 * ✓-markerade ord räknas alltså också — man kan lära sig spanska utanför
 * appen — men en enskild dag får bidra med max TAK_PER_DAG nya ord, så en
 * städdag där någon bockar av hela sitt gamla ordförråd inte blåser upp
 * prognosen. Böjningsformer räknas som ord — de är riktiga kort.
 */

export const MEXIKO_ISO = "2026-12-26";
export const TAKT_FONSTER = 30; // dagar bakåt som takten mäts över
export const MIN_DAGAR = 3;     // kortare historik än så → ingen prognos
export const TAK_PER_DAG = 50;  // maxbidrag per kalenderdag (dämpar bara riktiga bulk-✓-städdagar)

const DAG_MS = 86_400_000;

export function dagarKvar(now: Date, malIso: string = MEXIKO_ISO): number {
  const mal = new Date(`${malIso}T00:00:00`);
  return Math.max(0, Math.ceil((mal.getTime() - now.getTime()) / DAG_MS));
}

export interface Takt {
  perDag: number;      // nya ord per dag i fönstret (dagstak tillämpat)
  nyaIFonstret: number;
  dagar: number;       // fönstrets faktiska längd (≤ TAKT_FONSTER)
}

type TaktKort = Pick<CardRec, "wordId" | "introducedAt"> & { fsrs: { reps: number } };

/** Nya ord per dag ur korten. null = kortare historik än MIN_DAGAR. */
export function taktPerDag(
  cards: Iterable<TaktKort>,
  now: Date,
  fonster: number = TAKT_FONSTER,
  tak: number = TAK_PER_DAG,
): Takt | null {
  // ordets inträdesdag = äldsta introducedAt bland kort med minst ett svar
  const intrade = new Map<string, string>();
  for (const c of cards) {
    if (c.fsrs.reps <= 0) continue; // obesvarat = ingen poäng = ingen takt
    const prev = intrade.get(c.wordId);
    if (!prev || c.introducedAt < prev) intrade.set(c.wordId, c.introducedAt);
  }
  if (!intrade.size) return null;
  let aldst = Infinity;
  for (const ts of intrade.values()) aldst = Math.min(aldst, new Date(ts).getTime());
  const dagarAktiv = Math.max(1, Math.ceil((now.getTime() - aldst) / DAG_MS));
  if (dagarAktiv < MIN_DAGAR) return null;
  const dagar = Math.min(fonster, dagarAktiv);
  const grans = now.getTime() - dagar * DAG_MS;
  // räkna per kalenderdag och kapa varje dag — jämn inlärning utanför appen
  // räknas fullt, en bulkdag räknas som högst `tak`
  const perDagAntal = new Map<string, number>();
  for (const ts of intrade.values()) {
    if (new Date(ts).getTime() < grans) continue;
    const dag = ts.slice(0, 10);
    perDagAntal.set(dag, (perDagAntal.get(dag) ?? 0) + 1);
  }
  let nya = 0;
  for (const n of perDagAntal.values()) nya += Math.min(n, tak);
  return { perDag: nya / dagar, nyaIFonstret: nya, dagar };
}

/** Var landar man till Mexiko om takten håller? Cappad vid basens tak (ord + former). */
export function prognosOrd(
  scoreNu: number,
  takt: Takt,
  now: Date,
  total = 7843,
): number {
  return Math.min(total, Math.round(scoreNu + takt.perDag * dagarKvar(now)));
}
