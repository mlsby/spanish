import { beforeEach, describe, expect, it } from "vitest";
import { Session } from "../src/lib/session";
import { isKnown, newCardRec } from "../src/lib/scheduler";
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

describe("introduktion av nya ord", () => {
  it("skapar två kort per ord i frekvensordning, respekterar dagstakten, idempotent", () => {
    const store = makeStore();
    store.data.settings.newPerDay = 2;
    const fresh = store.introduceToday();
    expect(fresh).toHaveLength(4); // 2 ord × 2 riktningar
    // es→sv-korten först, sedan sv→es — samma ord förhörs inte rygg i rygg
    expect(fresh.map((c) => `${c.wordId}:${c.dir}`)).toEqual([
      "empezar|v:es2sv", "ciudad|n:es2sv", "empezar|v:sv2es", "ciudad|n:sv2es",
    ]);
    expect(store.introduceToday()).toHaveLength(0); // samma dag → inget mer
  });

  it("dagsbudgeten delas mellan enheter — härleds ur korten, inte en lokal räknare", () => {
    const store = makeStore();
    store.data.settings.newPerDay = 2;
    // simulera moln-pull: två ord introducerades idag på en annan enhet
    const now = new Date();
    for (const id of ["empezar|v", "ciudad|n"]) {
      store.data.cards[`${id}:es2sv`] = newCardRec(id, "es2sv", now);
      store.data.cards[`${id}:sv2es`] = newCardRec(id, "sv2es", now);
    }
    expect(store.introducedToday()).toBe(2);
    expect(store.introduceToday()).toHaveLength(0); // budgeten redan full idag
    expect(store.stats().newAvailable).toBe(0);
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

  it("stavfel → hard, synonym → good", () => {
    const card = newCardRec("empezar|v", "es2sv", new Date());
    const s = new Session(store, [card]);
    expect(s.answer("börjaa").grade).toBe("hard");
    s.commit();
    const s2 = new Session(store, [store.card("empezar|v", "es2sv")!]);
    expect(s2.answer("starta").grade).toBe("good");
  });

  it("sv→es: artikeln krävs inte", () => {
    const card = newCardRec("ciudad|n", "sv2es", new Date());
    const s = new Session(store, [card]);
    expect(s.answer("ciudad").grade).toBe("good");
    const s2 = new Session(store, [newCardRec("ciudad|n", "sv2es", new Date())]);
    expect(s2.answer("la ciudad").grade).toBe("good");
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
  it("kräver stabilitet ≥ 30 dagar", () => {
    const rec = newCardRec("empezar|v", "es2sv", new Date());
    expect(isKnown(rec)).toBe(false);
    rec.fsrs.stability = 31;
    expect(isKnown(rec)).toBe(true);
  });
});
