import type { Grade, Step } from "./types";

export type AnswerLang = "sv" | "es";

/**
 * Steg 1 — normalisering enligt kravspec §3:
 *  - gemener, trimmade/ihopslagna mellanslag
 *  - spanska svar: accentokänsligt (á→a … ü→u) men ñ BEHÅLLS (betydelsebärande),
 *    inledande artikel (el/la/los/las/un/una) och ¡¿-tecken skalas bort
 *  - svenska svar: é/è/ê→e, á/à→a men å/ä/ö BEHÅLLS (betydelsebärande),
 *    inledande "att " skalas bort (verbsvar)
 */
export function normalize(s: string, lang: AnswerLang): string {
  let t = s.toLowerCase().replace(/[¡!¿?.]/g, " ").replace(/\s+/g, " ").trim();
  if (lang === "es") {
    t = t
      .replace(/á/g, "a").replace(/é/g, "e").replace(/í/g, "i")
      .replace(/ó/g, "o").replace(/ú/g, "u").replace(/ü/g, "u");
    t = t.replace(/^(el|la|los|las|un|una) /, "");
  } else {
    t = t.replace(/[éèê]/g, "e").replace(/[áà]/g, "a");
    t = t.replace(/^att /, "");
  }
  return t;
}

/** Damerau-Levenshtein (OSA-varianten). */
export function dl(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 3) return 99;
  const d: number[][] = [];
  for (let i = 0; i <= m; i++) d[i] = [i];
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}

export interface GradeResult {
  grade: Grade;
  step: Step;
  /** närmaste facit vid stavfel — för "rättstavat"-visningen */
  matched?: string;
}

/**
 * Ett facit med snedstreck ("han/hon är") är egentligen flera svar —
 * varje variant godkänns för sig. Originalet behålls också (om någon
 * faktiskt skriver snedstrecket). Kartesisk produkt per ord, med tak.
 */
export function slashVariants(target: string): string[] {
  if (!target.includes("/")) return [target];
  let combos: string[][] = [[]];
  for (const tok of target.split(/\s+/)) {
    const opts = tok.split("/").filter(Boolean);
    if (!opts.length) continue;
    const next: string[][] = [];
    for (const c of combos) {
      for (const o of opts) {
        next.push([...c, o]);
        if (next.length >= 24) break;
      }
      if (next.length >= 24) break;
    }
    combos = next;
  }
  return [target, ...combos.map((c) => c.join(" ")).filter((v) => v !== target)];
}

/**
 * Steg 1–2 av rättningen. `targets[0]` är huvudöversättningen, resten synonymer.
 * Varje facit expanderas på snedstreck — varianter av huvudfacit räknas som exakta.
 * (Steg 3, AI-fallbacken, kräver server och ersätts i v1 av "Jag hade rätt"-knappen.)
 */
export function gradeAnswer(raw: string, targets: string[], lang: AnswerLang): GradeResult {
  const n = normalize(raw, lang);
  if (!n) return { grade: "again", step: "none" };
  const flat: { norm: string; show: string; origin: number }[] = [];
  targets.forEach((t, i) => {
    for (const v of slashVariants(t)) flat.push({ norm: normalize(v, lang), show: v, origin: i });
  });
  const iExact = flat.findIndex((t) => t.norm === n);
  if (iExact >= 0) return { grade: "good", step: flat[iExact].origin === 0 ? "exact" : "syn" };
  let best = 99, bi = -1;
  flat.forEach((t, i) => {
    const d0 = dl(n, t.norm);
    if (d0 < best) { best = d0; bi = i; }
  });
  const limit = n.length <= 5 ? 1 : 2;
  if (best <= limit) return { grade: "hard", step: "fuzzy", matched: flat[bi].show };
  return { grade: "again", step: "none" };
}
