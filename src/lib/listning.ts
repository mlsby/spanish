import type { WordStatus } from "./store";
import type { Level } from "./types";

/**
 * Ordlistans sortering och filter — ren logik utan DOM så den kan testas.
 * "Omötta ord sist" gäller nyast och krångligast: listor som bygger på
 * kortdata kan inte rangordna ord man aldrig mött, så de behåller
 * frekvensordningen längst ner.
 */

export type SortKey = "vanligast" | "nyast" | "kranglig" | "alfa";

export const SORT_SV: Record<SortKey, string> = {
  vanligast: "Vanligast", nyast: "Nyast", kranglig: "Krångligast", alfa: "A–Ö",
};

export type RegelFilter = "kompis" | "egen" | "saknar";
export type PosGrupp = "n" | "v" | "adj" | "form" | "ovrig";

export interface ListFilter {
  niva: Level[];
  regler: RegelFilter[];
  pos: PosGrupp[];
}

export const tomFilter = (): ListFilter => ({ niva: [], regler: [], pos: [] });

export function antalFilter(f: ListFilter): number {
  return f.niva.length + f.regler.length + f.pos.length;
}

/** Senaste introduktionstidpunkten för ordet (null = inte mött än). */
export function introAt(ws: WordStatus): string | null {
  let max: string | null = null;
  for (const c of ws.cards) if (!max || c.introducedAt > max) max = c.introducedAt;
  return max;
}

export function felAntal(ws: WordStatus): number {
  return ws.cards.reduce((n, c) => n + c.failCount, 0);
}

export function posGrupp(pos: string): PosGrupp {
  if (pos === "vform") return "form"; // verbböjningar — egna rader i listan
  return pos === "n" || pos === "v" || pos === "adj" ? pos : "ovrig";
}

/** Sorterar en redan rankordnad lista (muterar inte originalet). */
export function sorteraLista(list: WordStatus[], sort: SortKey): WordStatus[] {
  if (sort === "vanligast") return list;
  const out = [...list];
  if (sort === "alfa") {
    out.sort((a, b) => a.word.es.localeCompare(b.word.es, "es") || a.word.rank - b.word.rank);
  } else if (sort === "nyast") {
    out.sort((a, b) => {
      const ia = introAt(a), ib = introAt(b);
      if (ia && ib) return ib > ia ? 1 : ib < ia ? -1 : a.word.rank - b.word.rank;
      if (ia || ib) return ia ? -1 : 1; // mötta före omötta
      return a.word.rank - b.word.rank;
    });
  } else { // kranglig: flest fel överst, omötta sist
    out.sort((a, b) => {
      const ma = a.cards.length ? 1 : 0, mb = b.cards.length ? 1 : 0;
      if (ma !== mb) return mb - ma;
      return felAntal(b) - felAntal(a) || a.word.rank - b.word.rank;
    });
  }
  return out;
}

/** Filtrerar: OR inom varje grupp, AND mellan grupperna. */
export function filtreraLista(
  list: WordStatus[],
  f: ListFilter,
  harKompisregel: (wordId: string) => boolean,
  harEgenRegel: (wordId: string) => boolean,
): WordStatus[] {
  if (!antalFilter(f)) return list;
  return list.filter((ws) => {
    if (f.niva.length && !f.niva.includes(ws.level)) return false;
    if (f.pos.length && !f.pos.includes(posGrupp(ws.word.pos))) return false;
    if (f.regler.length) {
      const kompis = harKompisregel(ws.word.id);
      const egen = harEgenRegel(ws.word.id);
      const ok = f.regler.some((r) =>
        r === "kompis" ? kompis : r === "egen" ? egen : !kompis && !egen);
      if (!ok) return false;
    }
    return true;
  });
}

const MANAD = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];

/** "idag" · "igår" · "6 aug" — för raddatumet i nyast-läget. */
export function dagEtikett(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const idag = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dagen = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = Math.round((idag.getTime() - dagen.getTime()) / 86_400_000);
  if (diff <= 0) return "idag";
  if (diff === 1) return "igår";
  return `${d.getDate()} ${MANAD[d.getMonth()]}`;
}
