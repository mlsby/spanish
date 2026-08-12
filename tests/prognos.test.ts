import { describe, expect, it } from "vitest";
import { dagarKvar, prognosOrd, TAK_PER_DAG, taktPerDag } from "../src/lib/prognos";

const NU = new Date("2026-08-12T12:00:00Z");
const dagarSen = (n: number) => new Date(NU.getTime() - n * 86_400_000).toISOString();

function kort(wordId: string, introDagarSen: number, reps = 1) {
  return { wordId, introducedAt: dagarSen(introDagarSen), fsrs: { reps } };
}

describe("Mexiko-prognosen", () => {
  it("dagarKvar räknar till avresan 26 dec 2026", () => {
    expect(dagarKvar(new Date("2026-12-25T12:00:00"))).toBe(1);
    expect(dagarKvar(new Date("2026-12-27T12:00:00"))).toBe(0); // resan har gått
    expect(dagarKvar(NU)).toBeGreaterThan(100);
  });

  it("takten räknas ur korten — båda riktningarna ger ändå ETT ord", () => {
    const cards = [
      kort("casa|n", 10), kort("casa|n", 10),
      kort("ser|v", 5), kort("ser|v", 5),
      kort("cada|determiner", 4), kort("cada|determiner", 4),
    ];
    const t = taktPerDag(cards, NU, 30)!;
    expect(t.nyaIFonstret).toBe(3);
    expect(t.dagar).toBe(10); // aktiv i 10 dagar — fönstret krymper till historiken
    expect(t.perDag).toBeCloseTo(0.3);
  });

  it("obesvarade introduktioner och böjningsformer räknas inte", () => {
    const cards = [
      kort("ser|v", 5),
      kort("casa|n", 4, 0),          // introducerad men aldrig besvarad
      kort("ser|v#pres.3s", 4),      // böjning — utanför poängen
    ];
    expect(taktPerDag(cards, NU, 30)!.nyaIFonstret).toBe(1);
  });

  it("en bulkdag kapas vid dagstaket — jämn inlärning berörs inte", () => {
    const cards = [
      ...Array.from({ length: 70 }, (_, i) => kort(`bulk${i}|n`, 2)), // städdag: 70 ✓
      kort("a|n", 5), kort("b|n", 5), kort("c|n", 5),                 // vanlig dag: 3
      kort("gammal|n", 45),                                           // utanför fönstret
    ];
    const t = taktPerDag(cards, NU, 30)!;
    expect(t.nyaIFonstret).toBe(TAK_PER_DAG + 3);
    expect(t.dagar).toBe(30);
  });

  it("kortare historik än 3 dagar ger ingen prognos", () => {
    expect(taktPerDag([], NU)).toBeNull();
    expect(taktPerDag([kort("casa|n", 1)], NU)).toBeNull();
  });

  it("prognosen cappar vid ordbasens tak", () => {
    const takt = { perDag: 100, nyaIFonstret: 3000, dagar: 30 };
    expect(prognosOrd(500, takt, NU)).toBe(5000);
    expect(prognosOrd(500, { ...takt, perDag: 1 }, NU)).toBe(500 + dagarKvar(NU));
  });
});
