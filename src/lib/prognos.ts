import type { ReviewRec } from "./types";

/**
 * Mexiko-prognosen: hela gänget åker 26 dec 2026 — grafen visar orden man
 * har nu (kan + på gång) och var man landar om takten håller i sig.
 *
 * Takten räknas ur review-loggen, INTE ur poängserien: ett ord räknas den
 * dag det fick sin FÖRSTA riktiga övning. Snabbmarkerade ord (✓ i ordlistan,
 * "kan redan") skapar inga reviews och blåser därmed aldrig upp takten —
 * de var ju ord man kunde sen innan. Böjningsformer ingår inte i poängen
 * och räknas därför inte heller här.
 */

export const MEXIKO_ISO = "2026-12-26";
export const TAKT_FONSTER = 30; // dagar bakåt som takten mäts över
export const MIN_DAGAR = 3;     // kortare historik än så → ingen prognos

const DAG_MS = 86_400_000;

export function dagarKvar(now: Date, malIso: string = MEXIKO_ISO): number {
  const mal = new Date(`${malIso}T00:00:00`);
  return Math.max(0, Math.ceil((mal.getTime() - now.getTime()) / DAG_MS));
}

export interface Takt {
  perDag: number;      // nya riktigt övade ord per dag i fönstret
  nyaIFonstret: number;
  dagar: number;       // fönstrets faktiska längd (≤ TAKT_FONSTER)
}

/** Nya ord per dag — ordets första review i fönstret räknas. null = för tidigt. */
export function taktPerDag(
  reviews: Pick<ReviewRec, "ts" | "wordId">[],
  now: Date,
  fonster: number = TAKT_FONSTER,
): Takt | null {
  const forsta = new Map<string, string>();
  for (const r of reviews) {
    if (r.wordId.includes("#")) continue; // böjningar ligger utanför poängen
    const prev = forsta.get(r.wordId);
    if (!prev || r.ts < prev) forsta.set(r.wordId, r.ts);
  }
  if (!forsta.size) return null;
  let aldst = Infinity;
  for (const ts of forsta.values()) aldst = Math.min(aldst, new Date(ts).getTime());
  const dagarAktiv = Math.max(1, Math.ceil((now.getTime() - aldst) / DAG_MS));
  if (dagarAktiv < MIN_DAGAR) return null;
  const dagar = Math.min(fonster, dagarAktiv);
  const grans = now.getTime() - dagar * DAG_MS;
  let nya = 0;
  for (const ts of forsta.values()) if (new Date(ts).getTime() >= grans) nya++;
  return { perDag: nya / dagar, nyaIFonstret: nya, dagar };
}

/** Var landar man till Mexiko om takten håller? Cappad vid ordbasens tak. */
export function prognosOrd(
  scoreNu: number,
  takt: Takt,
  now: Date,
  total = 5000,
): number {
  return Math.min(total, Math.round(scoreNu + takt.perDag * dagarKvar(now)));
}
