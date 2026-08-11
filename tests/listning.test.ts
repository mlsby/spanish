import { describe, expect, it } from "vitest";
import {
  antalFilter, dagEtikett, felAntal, filtreraLista, introAt,
  posGrupp, sorteraLista, tomFilter,
} from "../src/lib/listning";
import type { WordStatus } from "../src/lib/store";
import type { Level, Word } from "../src/lib/types";

function ws(opts: {
  id: string; rank: number; pos?: string; es?: string;
  intro?: string[]; fails?: number[]; level?: Level;
}): WordStatus {
  const word = {
    id: opts.id, es: opts.es ?? opts.id, sv: "x", pos: opts.pos ?? "n",
    rank: opts.rank, syn: [],
  } as unknown as Word;
  const cards = (opts.intro ?? []).map((at, i) => ({
    wordId: opts.id, dir: i === 0 ? "es2sv" : "sv2es", introducedAt: at,
    failCount: opts.fails?.[i] ?? 0,
    fsrs: { reps: 1, stability: 1 },
  })) as unknown as WordStatus["cards"];
  return { word, cards, status: cards.length ? "lar" : "ny", minStability: 1, level: opts.level ?? (cards.length ? "ovar" : "ny") };
}

describe("sorteraLista", () => {
  const a = ws({ id: "a", rank: 1, intro: ["2026-08-01T10:00:00Z"] });
  const b = ws({ id: "b", rank: 2, intro: ["2026-08-10T10:00:00Z", "2026-08-03T10:00:00Z"] });
  const c = ws({ id: "c", rank: 3 }); // omött
  const d = ws({ id: "d", rank: 4, intro: ["2026-08-05T10:00:00Z"] });

  it("vanligast lämnar rankordningen orörd", () => {
    expect(sorteraLista([a, b, c, d], "vanligast").map((w) => w.word.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("nyast: senast introducerad först, omötta sist", () => {
    expect(sorteraLista([a, b, c, d], "nyast").map((w) => w.word.id)).toEqual(["b", "d", "a", "c"]);
  });

  it("nyast använder senaste kortets introduktion", () => {
    expect(introAt(b)).toBe("2026-08-10T10:00:00Z");
    expect(introAt(c)).toBeNull();
  });

  it("krångligast: flest fel överst, omötta sist", () => {
    const x = ws({ id: "x", rank: 1, intro: ["2026-08-01", "2026-08-01"], fails: [2, 1] });
    const y = ws({ id: "y", rank: 2, intro: ["2026-08-01"], fails: [9] });
    const z = ws({ id: "z", rank: 3 });
    expect(felAntal(x)).toBe(3);
    expect(sorteraLista([x, y, z], "kranglig").map((w) => w.word.id)).toEqual(["y", "x", "z"]);
  });

  it("a–ö sorterar spanskt alfabetiskt", () => {
    const n = ws({ id: "n", rank: 1, es: "nube" });
    const ñ = ws({ id: "ñ", rank: 2, es: "ñoño" });
    const o = ws({ id: "o", rank: 3, es: "oso" });
    expect(sorteraLista([o, ñ, n], "alfa").map((w) => w.word.es)).toEqual(["nube", "ñoño", "oso"]);
  });
});

describe("filtreraLista", () => {
  const ny = ws({ id: "ny", rank: 1, level: "ny" });
  const ovar = ws({ id: "ovar", rank: 2, intro: ["2026-08-01"], level: "ovar", pos: "v" });
  const kan = ws({ id: "kan", rank: 3, intro: ["2026-07-01"], level: "kan", pos: "adv" });
  const alla = [ny, ovar, kan];
  const inga = () => false;

  it("tomt filter släpper igenom allt", () => {
    expect(filtreraLista(alla, tomFilter(), inga, inga)).toHaveLength(3);
    expect(antalFilter(tomFilter())).toBe(0);
  });

  it("nivå är OR inom gruppen", () => {
    const f = { ...tomFilter(), niva: ["ny", "kan"] as Level[] };
    expect(filtreraLista(alla, f, inga, inga).map((w) => w.word.id)).toEqual(["ny", "kan"]);
  });

  it("ordklass grupperar övrigt", () => {
    expect(posGrupp("adv")).toBe("ovrig");
    const f = { ...tomFilter(), pos: ["ovrig"] as const };
    expect(filtreraLista(alla, { ...f, pos: [...f.pos] }, inga, inga).map((w) => w.word.id)).toEqual(["kan"]);
  });

  it("regler: kompis, egen och saknar", () => {
    const kompis = (id: string) => id === "ovar";
    const egen = (id: string) => id === "kan";
    const fKompis = { ...tomFilter(), regler: ["kompis"] as const };
    const fSaknar = { ...tomFilter(), regler: ["saknar"] as const };
    expect(filtreraLista(alla, { ...fKompis, regler: [...fKompis.regler] }, kompis, egen)
      .map((w) => w.word.id)).toEqual(["ovar"]);
    expect(filtreraLista(alla, { ...fSaknar, regler: [...fSaknar.regler] }, kompis, egen)
      .map((w) => w.word.id)).toEqual(["ny"]);
  });

  it("grupper kombineras med AND", () => {
    const f = { niva: ["ovar"] as Level[], regler: ["kompis"] as ("kompis")[], pos: [] };
    expect(filtreraLista(alla, f as never, (id) => id === "ovar", inga)).toHaveLength(1);
    expect(filtreraLista(alla, f as never, inga, inga)).toHaveLength(0);
  });
});

describe("dagEtikett", () => {
  const nu = new Date("2026-08-11T20:00:00");
  it("idag, igår och datum", () => {
    expect(dagEtikett("2026-08-11T07:00:00", nu)).toBe("idag");
    expect(dagEtikett("2026-08-10T23:00:00", nu)).toBe("igår");
    expect(dagEtikett("2026-08-06T10:00:00", nu)).toBe("6 aug");
  });
});
