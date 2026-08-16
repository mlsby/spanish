import { beforeEach, describe, expect, it } from "vitest";
import { Session } from "../src/lib/session";
import { applyReview, isKnown, newCardRec } from "../src/lib/scheduler";
import { Store } from "../src/lib/store";
import { emptyData, type StorageAdapter } from "../src/lib/storage";
import type { AppData, Word } from "../src/lib/types";

class MemAdapter implements StorageAdapter {
  d: AppData | null = null;
  load() { return this.d; }
  save(x: AppData) { this.d = x; }
}

const WORDS: Word[] = [
  { id: "empezar|v", rank: 1, es: "empezar", pos: "v", sv: "börja", syn: ["starta"], alt: ["comenzar"] },
  { id: "ciudad|n", rank: 2, es: "ciudad", pos: "n", sv: "stad", syn: [], art: "la" },
  { id: "feliz|adj", rank: 3, es: "feliz", pos: "adj", sv: "lycklig", syn: [] },
];

function makeStore(): Store {
  const store = new Store(new MemAdapter());
  store.words = WORDS;
  store.byId = new Map(WORDS.map((w) => [w.id, w]));
  store.data = emptyData();
  return store;
}

describe("portionsmotorn: Öva bygger dagens portion", () => {
  it("tom historik: portionen fylls med nya ord — es→sv först, ärvda staplas inte", () => {
    const store = makeStore();
    const plan = store.portionsPlan();
    expect(plan.rep).toHaveLength(0);
    expect(plan.nyaUnits).toHaveLength(3); // hela lilla basen ryms i portionen
    expect(plan.nyaOrd).toBe(3);
    const kort = store.startPortion();
    expect(kort.map((c) => `${c.wordId}:${c.dir}`)).toEqual([
      "empezar|v:es2sv", "ciudad|n:es2sv", "feliz|adj:es2sv",
      "empezar|v:sv2es", "ciudad|n:sv2es", "feliz|adj:sv2es",
    ]);
    // omstart utan att ha övat: de osedda ärvs — inget staplas ovanpå
    const plan2 = store.portionsPlan();
    expect(plan2.nyaUnits).toHaveLength(0);
    expect(plan2.unseen).toHaveLength(6);
    expect(plan2.nyaOrd).toBe(3);
  });

  it("ambitionsnivåerna styr portionens kort och dagsbudgeten", () => {
    const store = makeStore();
    expect(store.nivaConf()).toEqual({ kort: 30, nya: 20 });
    store.setNiva("lugn");
    expect(store.nivaConf()).toEqual({ kort: 20, nya: 15 });
    store.setNiva("ambitios");
    expect(store.nivaConf()).toEqual({ kort: 40, nya: 25 });
  });

  it("repskuld fyller portionen — nya ord väntar tills högen är nere", () => {
    const store = makeStore();
    store.setNiva("lugn"); // 20 kort per portion
    const now = Date.now();
    for (let i = 0; i < 25; i++) {
      const c = newCardRec(`skuld${i}|n`, "es2sv", new Date());
      c.fsrs.reps = 1;
      c.fsrs.stability = 5;
      c.fsrs.due = new Date(now - (i + 1) * 3600e3).toISOString();
      store.data.cards[`skuld${i}|n:es2sv`] = c;
    }
    const plan = store.portionsPlan();
    expect(plan.rep).toHaveLength(20);
    expect(plan.nyaUnits).toHaveLength(0); // skuld kvar utanför portionen
    expect(plan.forvag).toHaveLength(0);
    expect(plan.totalKort).toBe(20);
  });

  it("ömtåliga kort går före: relativ försening slår rå väntetid", () => {
    const store = makeStore();
    const now = Date.now();
    const mk = (id: string, stab: number, dagarSen: number) => {
      const c = newCardRec(id, "es2sv", new Date());
      c.fsrs.reps = 1;
      c.fsrs.stability = stab;
      c.fsrs.due = new Date(now - dagarSen * 86400e3).toISOString();
      store.data.cards[`${id}:es2sv`] = c;
    };
    mk("gammal|n", 60, 3); // stabilt kort, 3 dagar sent — tål väntan
    mk("farsk|n", 1, 1);   // färskt kort, 1 dag sent — glöms på dagar
    const plan = store.portionsPlan();
    expect(plan.rep[0].wordId).toBe("farsk|n");
  });

  it("utan skuld fylls portionen i förväg — närmast förfall först", () => {
    const store = makeStore();
    const now = Date.now();
    const mk = (id: string, dueMs: number) => {
      const c = newCardRec(id, "es2sv", new Date());
      c.fsrs.reps = 1;
      c.fsrs.due = new Date(dueMs).toISOString();
      store.data.cards[`${id}:es2sv`] = c;
    };
    mk("empezar|v", now - 3600e3);       // förfallet
    mk("ciudad|n", now + 5 * 86400e3);   // om 5 dagar
    mk("feliz|adj", now + 2 * 86400e3);  // om 2 dagar
    const plan = store.portionsPlan();
    expect(plan.rep.map((c) => c.wordId)).toEqual(["empezar|v"]);
    expect(plan.nyaUnits).toHaveLength(0); // alla ord har redan kort
    expect(plan.forvag.map((c) => c.wordId)).toEqual(["feliz|adj", "ciudad|n"]);
    expect(plan.repKort).toBe(3);
    expect(store.glosorKlara()).toBe(false); // empezar är förfallet
  });

  it("glosorKlara: inga förfallna + inget nytt kvar ⇒ läsövning förvald", () => {
    const store = makeStore();
    const now = Date.now();
    for (const w of ["empezar|v", "ciudad|n", "feliz|adj"]) {
      const c = newCardRec(w, "es2sv", new Date());
      c.fsrs.reps = 1;
      c.fsrs.due = new Date(now + 3 * 86400e3).toISOString();
      store.data.cards[`${w}:es2sv`] = c;
    }
    expect(store.glosorKlara()).toBe(true); // ordbasen slut → klart trots budget kvar
  });
});

describe("session: betygsmappning och tvåfelsregeln", () => {
  let store: Store;
  beforeEach(() => {
    store = makeStore();
  });

  it("exakt svar → good, fsrs uppdateras och kortet lämnar kön", () => {
    const card = newCardRec("empezar|v", "es2sv", new Date());
    const s = new Session(store, [card]);
    const p = s.answer("börja");
    expect(p.grade).toBe("good");
    s.commit();
    expect(s.counts.good).toBe(1);
    const saved = store.card("empezar|v", "es2sv")!;
    expect(saved.fsrs.reps).toBe(1);
    expect(saved.fsrs.stability).toBeGreaterThan(0);
    expect(store.data.reviews).toHaveLength(1);
    expect(store.data.reviews[0]).toMatchObject({ grade: "good", step: "exact", raw: "börja" });
  });

  it("stavfel → hard i UI:t, synonym → good", () => {
    const card = newCardRec("empezar|v", "es2sv", new Date());
    const s = new Session(store, [card]);
    expect(s.answer("börjaa").grade).toBe("hard");
    s.commit();
    const s2 = new Session(store, [store.card("empezar|v", "es2sv")!]);
    expect(s2.answer("starta").grade).toBe("good");
  });

  it("svenskt stavfel straffas inte: FSRS får good, loggen visar fuzzy", () => {
    // es→sv-stavfel ("börjaa") rättas som vanlig Good (inte Easy — det är
    // "kan redan"-knappens jobb) — samma stabilitet som ett rent Good-svar
    const a = new Session(store, [newCardRec("empezar|v", "es2sv", new Date())]);
    a.answer("börjaa"); a.commit();
    const typo = store.card("empezar|v", "es2sv")!.fsrs.stability;
    expect(store.data.reviews[store.data.reviews.length - 1]).toMatchObject({ grade: "good", step: "fuzzy" });
    const ref = applyReview(newCardRec("feliz|adj", "es2sv", new Date()), "good", new Date());
    expect(typo).toBe(ref.fsrs.stability);
    // spanskt stavfel förblir hard — stavningen ÄR kunskapen åt det hållet
    const c = new Session(store, [newCardRec("ciudad|n", "sv2es", new Date())]);
    c.answer("ciudda"); c.commit();
    expect(store.data.reviews[store.data.reviews.length - 1]).toMatchObject({ grade: "hard", step: "fuzzy" });
  });

  it("sv→es: artikeln krävs inte", () => {
    const card = newCardRec("ciudad|n", "sv2es", new Date());
    const s = new Session(store, [card]);
    expect(s.answer("ciudad").grade).toBe("good");
    const s2 = new Session(store, [newCardRec("ciudad|n", "sv2es", new Date())]);
    expect(s2.answer("la ciudad").grade).toBe("good");
  });

  it("es→sv: bestämd form räknas som rätt för substantiv — 'la ciudad' → 'staden'", () => {
    const s = new Session(store, [newCardRec("ciudad|n", "es2sv", new Date())]);
    expect(s.answer("staden").grade).toBe("good");
    // men inte för verb: böjda svenska verbformer är fortfarande inte facit
    const s2 = new Session(store, [newCardRec("empezar|v", "es2sv", new Date())]);
    expect(s2.answer("började").grade).not.toBe("good");
  });

  it("sv→es: alternativa spanska svar (alt) godkänns som synonym", () => {
    const s = new Session(store, [newCardRec("empezar|v", "sv2es", new Date())]);
    expect(s.answer("comenzar")).toMatchObject({ grade: "good", step: "syn" });
    const s2 = new Session(store, [newCardRec("empezar|v", "sv2es", new Date())]);
    expect(s2.answer("empezar").grade).toBe("good");
  });

  it("första felet: frivillig regel; andra felet: obligatorisk", () => {
    const card = newCardRec("feliz|adj", "es2sv", new Date());
    const s = new Session(store, [card]);
    const p1 = s.answer("glad");
    expect(p1.grade).toBe("again");
    expect(p1.forcedMnem).toBe(false); // första missen
    s.commit();
    expect(s.queue[0].failCount).toBe(1); // kortet kom tillbaka i kön
    const p2 = s.answer("nöjd");
    expect(p2.grade).toBe("again");
    expect(p2.forcedMnem).toBe(true); // andra missen → regel krävs
  });

  it("'vet inte' (tomt svar) → again, och tvåfelsregeln gäller som vanligt", () => {
    const card = newCardRec("feliz|adj", "es2sv", new Date());
    const s = new Session(store, [card]);
    const p1 = s.answer("");
    expect(p1).toMatchObject({ grade: "again", step: "none", forcedMnem: false });
    s.commit();
    expect(store.data.reviews[0]).toMatchObject({ grade: "again", raw: "" });
    const p2 = s.answer("");
    expect(p2.forcedMnem).toBe(true); // andra missen → regel krävs även via vet inte
  });

  it("'jag hade rätt' uppgraderar till hard och sparar synonymen", () => {
    const card = newCardRec("feliz|adj", "es2sv", new Date());
    const s = new Session(store, [card]);
    s.answer("glad");
    const p = s.override();
    expect(p.grade).toBe("hard");
    expect(p.step).toBe("override");
    expect(store.userWord("feliz|adj").syn).toContain("glad");
    s.commit();
    expect(store.data.reviews[0].step).toBe("override");
    // nästa gång rättas synonymen direkt utan override
    const s2 = new Session(store, [store.card("feliz|adj", "es2sv")!]);
    expect(s2.answer("glad").grade).toBe("good");
  });

  it("fel svar återkommer i samma pass tills det sitter", () => {
    const cards = ["empezar|v", "ciudad|n", "feliz|adj"].map((id) => newCardRec(id, "es2sv", new Date()));
    const s = new Session(store, cards);
    s.answer("fel svar");
    s.commit();
    expect(s.queue.map((c) => c.wordId)).toContain("empezar|v");
  });
});

describe("Kan det-etiketten", () => {
  it("kräver stabilitet ≥ 21 dagar (Anki-mature)", () => {
    const rec = newCardRec("empezar|v", "es2sv", new Date());
    expect(isKnown(rec)).toBe(false);
    rec.fsrs.stability = 20.9;
    expect(isKnown(rec)).toBe(false);
    rec.fsrs.stability = 21;
    expect(isKnown(rec)).toBe(true);
  });
});

describe("poängen räknar böjningsformer", () => {
  it("ett besvarat formkort ger score precis som ett ord", () => {
    const store = makeStore();
    const form = {
      id: "empezar|v#pres.1s", parent: "empezar|v", es: "empiezo",
      person: "1s" as const, svPres: "börjar", r: 500, slot: 1,
    };
    store.forms = [form];
    store.formById = new Map([[form.id, form]]);
    expect(store.stats().score).toBe(0);

    const rec = newCardRec(form.id, "es2sv", new Date());
    rec.fsrs.reps = 1; // besvarad → "på gång" → poäng
    store.putCard(rec);
    expect(store.stats().score).toBe(1);
    expect(store.stats().total).toBe(WORDS.length + 1);
  });
});
