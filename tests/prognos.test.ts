import { describe, expect, it } from "vitest";
import { dagarKvar, prognosOrd, taktPerDag } from "../src/lib/prognos";

const NU = new Date("2026-08-12T12:00:00Z");
const dagarSen = (n: number) => new Date(NU.getTime() - n * 86_400_000).toISOString();

describe("Mexiko-prognosen", () => {
  it("dagarKvar räknar till avresan 26 dec 2026", () => {
    expect(dagarKvar(new Date("2026-12-25T12:00:00"))).toBe(1);
    expect(dagarKvar(new Date("2026-12-27T12:00:00"))).toBe(0); // resan har gått
    expect(dagarKvar(NU)).toBeGreaterThan(100);
  });

  it("takten räknar ordets FÖRSTA review — senare repetitioner ändrar inget", () => {
    const reviews = [
      { ts: dagarSen(10), wordId: "casa|n" },
      { ts: dagarSen(2), wordId: "casa|n" },  // repetition — räknas inte igen
      { ts: dagarSen(5), wordId: "ser|v" },
      { ts: dagarSen(4), wordId: "cada|determiner" },
    ];
    const t = taktPerDag(reviews, NU, 30)!;
    expect(t.nyaIFonstret).toBe(3);
    expect(t.dagar).toBe(10); // aktiv i 10 dagar — fönstret krymper till historiken
    expect(t.perDag).toBeCloseTo(0.3);
  });

  it("böjningsformer räknas inte (ligger utanför poängen)", () => {
    const reviews = [
      { ts: dagarSen(5), wordId: "ser|v" },
      { ts: dagarSen(4), wordId: "ser|v#pres.3s" },
    ];
    expect(taktPerDag(reviews, NU, 30)!.nyaIFonstret).toBe(1);
  });

  it("gamla ord utanför fönstret räknas inte i takten", () => {
    const reviews = [
      { ts: dagarSen(45), wordId: "casa|n" },
      { ts: dagarSen(3), wordId: "ser|v" },
    ];
    const t = taktPerDag(reviews, NU, 30)!;
    expect(t.nyaIFonstret).toBe(1);
    expect(t.dagar).toBe(30);
  });

  it("kortare historik än 3 dagar ger ingen prognos — ✓-markeringar utan reviews likaså", () => {
    expect(taktPerDag([], NU)).toBeNull();
    expect(taktPerDag([{ ts: dagarSen(1), wordId: "casa|n" }], NU)).toBeNull();
  });

  it("prognosen cappar vid ordbasens tak", () => {
    const takt = { perDag: 100, nyaIFonstret: 3000, dagar: 30 };
    expect(prognosOrd(500, takt, NU)).toBe(5000);
    expect(prognosOrd(500, { ...takt, perDag: 1 }, NU)).toBe(500 + dagarKvar(NU));
  });
});
