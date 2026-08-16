import { beforeEach, describe, expect, it } from "vitest";
import { applyReview } from "../src/lib/scheduler";
import { Session } from "../src/lib/session";
import { Store } from "../src/lib/store";
import { emptyData, type StorageAdapter } from "../src/lib/storage";
import type { AppData, Word } from "../src/lib/types";

class MemAdapter implements StorageAdapter {
  d: AppData | null = null;
  load() { return this.d; }
  save(x: AppData) { this.d = x; }
}

const WORDS: Word[] = [
  { id: "hola|interj", rank: 1, es: "hola", pos: "interj", sv: "hej", syn: [] },
  { id: "casa|n", rank: 2, es: "casa", pos: "n", sv: "hus", syn: [], art: "la" },
];

function makeStore(): Store {
  const store = new Store(new MemAdapter());
  store.words = WORDS;
  store.byId = new Map(WORDS.map((w) => [w.id, w]));
  store.data = emptyData();
  return store;
}

describe("nivåstegen: beräknad nivå", () => {
  let store: Store;
  beforeEach(() => { store = makeStore(); });

  it("ny = inte mött än — även introducerad men obesvarad", () => {
    expect(store.wordStatus(WORDS[0]).level).toBe("ny");
    store.introduceUnits(1);
    expect(store.wordStatus(WORDS[0]).level).toBe("ny"); // kort finns, men inget svar än
    const s = new Session(store, [store.card("hola|interj", "es2sv")!]);
    s.answer("hej"); s.commit();
    expect(store.wordStatus(WORDS[0]).level).not.toBe("ny");
  });

  it("banden: <7 övar · 7–21 på gång · ≥21 båda håll kan det", () => {
    store.setLevel("hola|interj", "kan");
    expect(store.wordStatus(WORDS[0]).level).toBe("kan");
    store.setLevel("hola|interj", "pagang");
    expect(store.wordStatus(WORDS[0]).level).toBe("pagang");
    store.setLevel("hola|interj", "ovar");
    expect(store.wordStatus(WORDS[0]).level).toBe("ovar");
  });

  it("kan det kräver båda riktningarna — ena kortet på 30 d räcker inte", () => {
    store.setLevel("hola|interj", "kan");
    const sib = store.card("hola|interj", "sv2es")!;
    store.putCard({ ...sib, fsrs: { ...sib.fsrs, stability: 5 } });
    expect(store.wordStatus(WORDS[0]).level).not.toBe("kan");
  });
});

describe("nivåstegen: flytta för hand", () => {
  let store: Store;
  beforeEach(() => { store = makeStore(); });

  it("'kan det' på ett orört ord: ~21 d stabilitet, kollas om ~21 dagar", () => {
    const now = new Date();
    store.setLevel("hola|interj", "kan", now);
    for (const dir of ["es2sv", "sv2es"] as const) {
      const c = store.card("hola|interj", dir)!;
      expect(c.fsrs.stability).toBe(21);
      const days = (new Date(c.fsrs.due).getTime() - now.getTime()) / 86400e3;
      expect(days).toBeGreaterThan(20);
      expect(days).toBeLessThan(22);
    }
    // räknas i statistiken som "kan det"
    expect(store.stats().kan).toBe(1);
  });

  it("'övar' lägger ordet i dagens pass — och sänker en hög stabilitet in i bandet", () => {
    store.setLevel("hola|interj", "kan");
    store.setLevel("hola|interj", "ovar");
    const due = store.dueCards().filter((c) => c.wordId === "hola|interj");
    expect(due).toHaveLength(2);
    expect(due.every((c) => c.fsrs.stability <= 3)).toBe(true);
  });

  it("'övar' på ett helt nytt ord introducerar det — äkta första möte i dagens pass", () => {
    store.setLevel("casa|n", "ovar");
    const due = store.dueCards().filter((c) => c.wordId === "casa|n");
    expect(due).toHaveLength(2);
    expect(due.every((c) => c.fsrs.reps === 0)).toBe(true); // fast-track gäller fortfarande
  });

  it("'ny' nollställer — och är no-op på ett redan orört ord", () => {
    store.setLevel("hola|interj", "ny");
    expect(store.card("hola|interj", "es2sv")).toBeUndefined(); // inga kort skapades
    store.setLevel("hola|interj", "kan");
    store.setLevel("hola|interj", "ny");
    const c = store.card("hola|interj", "es2sv")!;
    expect(c.fsrs.reps).toBe(0);
    expect(store.wordStatus(WORDS[0]).level).toBe("ny");
  });

  it("markeringen är ärlig: fel vid nästa rep sänker stabiliteten rejält", () => {
    store.setLevel("hola|interj", "kan");
    const later = new Date(Date.now() + 21 * 86400e3);
    const failed = applyReview(store.card("hola|interj", "es2sv")!, "again", later);
    expect(failed.fsrs.stability).toBeLessThan(7); // tillbaka i inlärning
  });

  it("manuellt skapade kort går genom FSRS som vanligt vid rätt svar", () => {
    store.setLevel("hola|interj", "pagang");
    const later = new Date(Date.now() + 14 * 86400e3);
    const ok = applyReview(store.card("hola|interj", "es2sv")!, "good", later);
    expect(ok.fsrs.stability).toBeGreaterThan(14); // intervallet växer
  });

  it("'övar'-ordet rättas som vanligt i ett pass", () => {
    store.setLevel("casa|n", "ovar");
    const s = new Session(store, store.dueCards());
    const p = s.answer(s.current!.dir === "es2sv" ? "hus" : "la casa");
    expect(p.grade).toBe("good");
    expect(p.firstExposure).toBe(true);
    s.commit();
  });
});

describe("snabbmarkering: ✓ + ångra", () => {
  let store: Store;
  beforeEach(() => { store = makeStore(); });

  it("ångra på ett orört ord tar bort korten helt — tillbaka till Ny", () => {
    const snap = store.cardSnapshot("hola|interj");
    expect(snap).toEqual([null, null]);
    store.setLevel("hola|interj", "kan");
    expect(store.wordStatus(WORDS[0]).level).toBe("kan");
    store.restoreCards("hola|interj", snap);
    expect(store.card("hola|interj", "es2sv")).toBeUndefined();
    expect(store.card("hola|interj", "sv2es")).toBeUndefined();
    expect(store.wordStatus(WORDS[0]).level).toBe("ny");
  });

  it("ångra på ett påbörjat ord återställer exakt föregående FSRS-läge", () => {
    store.setLevel("hola|interj", "ovar");
    const s = new Session(store, [store.card("hola|interj", "es2sv")!]);
    s.answer("hej"); s.commit(); // lite riktig historik
    const before = store.card("hola|interj", "es2sv")!;
    const snap = store.cardSnapshot("hola|interj");
    store.setLevel("hola|interj", "kan");
    expect(store.card("hola|interj", "es2sv")!.fsrs.stability).toBe(21);
    store.restoreCards("hola|interj", snap);
    const after = store.card("hola|interj", "es2sv")!;
    expect(after.fsrs.stability).toBe(before.fsrs.stability);
    expect(after.fsrs.due).toBe(before.fsrs.due);
    expect(after.fsrs.reps).toBe(before.fsrs.reps);
  });
});
